import { resolve } from "node:path";
import { createStudioApp } from "@savia/studio-server";
import { cleanDeletedAttachmentObjects } from "@savia/studio-server/attachment-deletions";
import { describe, expect, it, vi } from "vitest";
import { migratePostgres } from "../src/postgres/migrations";
import { postgresTestUrl, withPostgresFixture } from "./postgres-fixture";

const live = postgresTestUrl ? describe : describe.skip;

live("Studio attachments on native PostgreSQL", () => {
  it.each([2, 1])(
    "resolves concurrent attachments with %i available slots",
    async (maxFiles) => {
      await withPostgresFixture(async (db, connectionString) => {
        await migratePostgres({
          connectionString,
          schema: "savia_core",
          directory: resolve(
            import.meta.dirname,
            "../../../packages/db/postgres",
          ),
          seed: false,
        });
        const tenant = "test";
        const object = "attachment_capacity";
        const recordId = "test-record";
        const config = {
          fields: {
            contract: {
              type: "R2Attachment",
              label: "Contract",
              config: { maxFiles },
            },
          },
        };
        await db
          .prepare(
            "INSERT INTO studio_objects(tenant_id,name,label,config) VALUES(?,?,?,?)",
          )
          .bind(tenant, object, object, JSON.stringify(config))
          .run();
        await db
          .prepare(
            "INSERT INTO studio_records(id,tenant_id,object_name,data) VALUES(?,?,?,'{}')",
          )
          .bind(recordId, tenant, object)
          .run();

        const objects = new Set<string>();
        const store = {
          put: vi.fn(async (key: string) => {
            objects.add(key);
          }),
          delete: vi.fn(async (keys: string | string[]) => {
            for (const key of [keys].flat()) objects.delete(key);
          }),
        };
        const env = {
          DB: db as unknown as D1Database,
          FILES: store as unknown as R2Bucket,
        };
        const app = createStudioApp(tenant);
        const upload = (path: string) => {
          const form = new FormData();
          form.set("field", "contract");
          form.set(
            "file",
            new File(["test"], "contract.pdf", { type: "application/pdf" }),
          );
          return app.request(path, { method: "POST", body: form }, env);
        };
        const uploaded = await upload(`/api/file-drafts/${object}`);
        expect(uploaded.status).toBe(201);
        const { data: draft } = (await uploaded.json()) as {
          data: { id: string; version: number };
        };

        // Let both transactions read capacity before either writes its attachment.
        let releaseChecks = () => {};
        const checksComplete = new Promise<void>((resolve) => {
          releaseChecks = resolve;
        });
        let checks = 0;
        const query = db.query.bind(db);
        const gatedQuery = vi
          .spyOn(db, "query")
          .mockImplementation(async (statement, client) => {
            const result = await query(statement, client);
            if (client && statement.sql.includes("AS attachment_counts")) {
              if (++checks === 2) releaseChecks();
              await checksComplete;
            }
            return result;
          });
        const filePath = `/api/files/${object}/${recordId}`;
        try {
          const requests = [
            upload(filePath),
            app.request(
              `/api/file-drafts/${draft.id}/attach`,
              {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ recordId, version: draft.version }),
              },
              env,
            ),
          ];
          const responses = await Promise.all(
            requests.map((request) =>
              Promise.resolve(request).finally(releaseChecks),
            ),
          );
          const statuses = await Promise.all(
            responses.map(async (response) => ({
              status: response.status,
              body: await response.json(),
            })),
          );
          expect(checks).toBeGreaterThanOrEqual(2);
          if (maxFiles === 2) {
            expect(
              statuses.map(({ status }) => status),
              JSON.stringify(statuses),
            ).toEqual([201, 200]);
          } else {
            expect(statuses.filter(({ status }) => status < 300)).toHaveLength(
              1,
            );
            expect(statuses.find(({ status }) => status >= 300)).toEqual({
              status: 422,
              body: { error: "Máximo de archivos alcanzado para este campo." },
            });
          }
          const list = await app.request(filePath, {}, env);
          const { data: files } = (await list.json()) as {
            data: { id: string; version: number }[];
          };
          const directRejected = statuses[0].status === 422;
          expect(files).toHaveLength(maxFiles);
          expect(files.filter(({ id }) => id === draft.id)).toHaveLength(
            statuses[1].status === 200 ? 1 : 0,
          );
          expect(objects.size).toBe(directRejected ? 1 : 2);
          expect(store.put).toHaveBeenCalledTimes(2);
          expect(store.delete).toHaveBeenCalledTimes(directRejected ? 1 : 0);

          if (maxFiles === 2) {
            const saved = files.find(({ id }) => id === draft.id)!;
            store.delete.mockRejectedValueOnce(
              new Error("Storage unavailable"),
            );
            const deleted = await app.request(
              `/api/file/${saved.id}`,
              {
                method: "DELETE",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ version: saved.version }),
              },
              env,
            );
            expect(deleted.status).toBe(200);
            expect(objects.size).toBe(2);
            const retried = await db
              .prepare(
                "UPDATE studio_file_deletions SET next_attempt_at=0 WHERE tenant_id=? AND file_id=?",
              )
              .bind(tenant, saved.id)
              .run();
            expect(retried.meta.changes).toBe(1);
            await cleanDeletedAttachmentObjects(env.DB, env.FILES);
            expect(objects.size).toBe(1);
          }
        } finally {
          gatedQuery.mockRestore();
        }
      });
    },
  );
});
