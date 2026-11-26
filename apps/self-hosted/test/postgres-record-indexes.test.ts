import { registerDialect, quoteIdentifier } from "@savia/db/dialect";
import {
  postgresDialect,
  postgresJsonSortParts,
} from "@savia/db/postgres-dialect";
import {
  recordIndexName,
  recordIndexStatements,
} from "../../../packages/studio-server/src/record-performance";
import { createObject } from "../../../packages/studio-server/src/schema";
import { makeConfig } from "../../../packages/studio-shared/src/metadata";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  migratePostgres,
  withPostgresDeploymentLock,
} from "../src/postgres/migrations";
import { ensurePostgresRecordIndexes } from "../src/postgres/record-indexes";
import { postgresParameters } from "../src/postgres/parameters";
import { postgresTestUrl, withPostgresFixture } from "./postgres-fixture";
import { describe, expect, it } from "vitest";
import { createStudioApp } from "@savia/studio-server";
import { buildRecordPageSelection } from "../../../packages/studio-server/src/record-page-query";

(postgresTestUrl ? describe : describe.skip)(
  "PostgreSQL record indexes",
  () => {
    it("reports an oversized performance index entry without saving a partial record", async () => {
      await withPostgresFixture(async (db, connectionString) => {
        await migratePostgres({
          connectionString,
          schema: "savia_core",
          directory: resolve("../../packages/db/postgres"),
          seed: false,
        });
        const tenant = "record-index-size";
        await createObject(db, tenant, {
          name: "items",
          label: "Items",
          config: {
            ...makeConfig({ name: { type: "Textbox", label: "Name" } }),
            performance: {
              indexes: [{ fields: ["name"], order: "ASC" }],
              summaries: [],
            },
          },
        });
        const app = createStudioApp(tenant, {
          principalId: "record-index-user",
        });
        const request = (name: string) =>
          app.request(
            "http://localhost/api/records/items",
            {
              method: "POST",
              body: JSON.stringify({ name }),
              headers: { "Content-Type": "application/json" },
            },
            { DB: db } as any,
          );
        const longName = Array.from({ length: 100 }, (_, value) =>
          createHash("sha256").update(String(value)).digest("hex"),
        ).join("");
        const failure = await request(longName);
        expect(failure.status).toBe(422);
        expect(await failure.json()).toMatchObject({
          error: { code: "PERFORMANCE_INDEX_ENTRY_TOO_LARGE" },
        });
        expect((await request("short name")).status).toBe(201);
        const records = await db
          .prepare(
            "SELECT data FROM studio_records WHERE tenant_id=? AND object_name=?",
          )
          .bind(tenant, "items")
          .all<{ data: string }>();
        expect(records.results.map((row) => JSON.parse(row.data).name)).toEqual(
          ["short name"],
        );

        const configure = (
          version: number,
          indexes: Array<{ fields: string[]; order: "ASC" }>,
        ) =>
          app.request(
            "http://localhost/api/objects/items/performance",
            {
              method: "PATCH",
              body: JSON.stringify({
                version,
                performance: { indexes, summaries: [] },
              }),
              headers: { "Content-Type": "application/json" },
            },
            { DB: db } as any,
          );
        expect((await configure(1, [])).status).toBe(200);
        expect((await request(longName)).status).toBe(201);
        const failureToIndex = await configure(2, [
          { fields: ["name"], order: "ASC" },
        ]);
        expect(failureToIndex.status).toBe(422);
        expect(await failureToIndex.json()).toMatchObject({
          error: { code: "PERFORMANCE_INDEX_ENTRY_TOO_LARGE" },
        });
        const saved = await db
          .prepare(
            "SELECT version,config FROM studio_objects WHERE tenant_id=? AND name=?",
          )
          .bind(tenant, "items")
          .first<{ version: number; config: string }>();
        expect(saved?.version).toBe(2);
        expect(JSON.parse(saved!.config).performance.indexes).toEqual([]);
      });
    }, 30_000);

    it("uses the same decimal key and range comparisons across session settings", async () => {
      await withPostgresFixture(async (_db, connectionString) => {
        await migratePostgres({
          connectionString,
          schema: "savia_core",
          directory: resolve("../../packages/db/postgres"),
          seed: false,
        });
        await withPostgresDeploymentLock(connectionString, async (client) => {
          const [, sortNumber] = postgresJsonSortParts("document", "$.amount");
          const amount = 1.2345678901234567;
          const document = JSON.stringify({ amount });
          const range = postgresDialect.jsonCompare(
            "document",
            "$.amount",
            "lte",
            amount,
          );
          const { text: sql } = postgresParameters(
            `WITH fixture(document) AS (VALUES (?::text)) SELECT ${sortNumber}::text AS key, ${range.sql} AS matches FROM fixture`,
          );
          await client.query("SET extra_float_digits TO 1");
          const standard = await client.query(sql, [
            document,
            ...range.parameters,
          ]);
          await client.query("SET extra_float_digits TO 0");
          const rounded = await client.query(sql, [
            document,
            ...range.parameters,
          ]);
          expect(standard.rows).toEqual([
            { key: String(amount), matches: true },
          ]);
          expect(rounded.rows).toEqual(standard.rows);
        });
      });
    }, 30_000);

    it("rebuilds older JSON indexes from metadata and preserves timestamp indexes on upgrade", async () => {
      await withPostgresFixture(async (db, connectionString) => {
        registerDialect(db, postgresDialect);
        const directory = resolve("../../packages/db/postgres");
        const migration = "0066_studio_json_sort_keys.sql";
        const legacyDirectory = await mkdtemp(
          join(tmpdir(), "savia-pg-legacy-index-"),
        );
        const options = {
          connectionString,
          schema: "savia_core" as const,
          seed: false,
        };
        try {
          const legacyFiles = (await readdir(directory)).filter(
            (file) => file.endsWith(".sql") && file < migration,
          );
          await Promise.all(
            legacyFiles.map((file) =>
              copyFile(join(directory, file), join(legacyDirectory, file)),
            ),
          );
          await migratePostgres({ ...options, directory: legacyDirectory });
        } finally {
          await rm(legacyDirectory, { recursive: true, force: true });
        }

        const tenant = "record-index-upgrade";
        const objectName = "items";
        const config = makeConfig({
          stage: { type: "Textbox", label: "Stage" },
        });
        await createObject(db, tenant, {
          name: objectName,
          label: "Items",
          config,
        });
        const index = { fields: ["stage"], order: "ASC" as const };
        const timestamp = { fields: ["created_at"], order: "ASC" as const };
        const indexes = [index, timestamp];
        const [jsonIndex, dateIndex] = await Promise.all(
          indexes.map((item) => recordIndexName(tenant, objectName, item)),
        );
        await db
          .prepare(
            "UPDATE studio_objects SET config=? WHERE tenant_id=? AND name=?",
          )
          .bind(
            JSON.stringify({
              ...config,
              performance: { indexes, summaries: [] },
            }),
            tenant,
            objectName,
          )
          .run();
        await db.exec(
          `CREATE INDEX ${quoteIdentifier(jsonIndex)} ON studio_records ((data::jsonb ->> 'stage'))`,
        );
        await db.batch(
          await recordIndexStatements(db, tenant, objectName, [], [timestamp]),
        );
        const readIndexes = () =>
          db
            .prepare(
              "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname='savia_core' AND indexname IN (?,?) ORDER BY indexname",
            )
            .bind(jsonIndex, dateIndex)
            .all<{ indexname: string; indexdef: string }>();
        const before = new Map(
          (await readIndexes()).results.map((row) => [
            row.indexname,
            row.indexdef,
          ]),
        );

        expect(await migratePostgres({ ...options, directory })).toEqual([
          migration,
        ]);
        expect((await readIndexes()).results).toEqual([
          { indexname: dateIndex, indexdef: before.get(dateIndex) },
        ]);
        await withPostgresDeploymentLock(connectionString, async (client) => {
          await client.query("SET search_path TO savia_core, pg_catalog");
          await ensurePostgresRecordIndexes(client);
        });
        const after = new Map(
          (await readIndexes()).results.map((row) => [
            row.indexname,
            row.indexdef,
          ]),
        );
        expect(after.get(jsonIndex)).toContain("studio_json_sort_rank");
        expect(after.get(dateIndex)).toBe(before.get(dateIndex));
      });
    }, 30_000);

    it("uses the configured JSON sort index for a 100k-row page query", async () => {
      await withPostgresFixture(async (db, connectionString) => {
        registerDialect(db, postgresDialect);
        await migratePostgres({
          connectionString,
          schema: "savia_core",
          directory: resolve("../../packages/db/postgres"),
          seed: false,
        });

        const tenant = "record-index-test";
        const objectName = "items";
        await createObject(db, tenant, {
          name: objectName,
          label: "Items",
          config: {
            ...makeConfig({
              stage: { type: "Textbox", label: "Stage" },
              amount: { type: "Number", label: "Amount" },
            }),
            performance: {
              indexes: [{ fields: ["stage", "amount"], order: "ASC" }],
              summaries: [],
            },
          },
        });
        for (let start = 1; start <= 100000; start += 1000)
          await db
            .prepare(
              `INSERT INTO studio_records(id,tenant_id,object_name,data)
             SELECT 'record-' || n, ?, ?, jsonb_build_object('stage','open','amount',n)
             FROM generate_series(?::int,?::int) AS n`,
            )
            .bind(tenant, objectName, start, start + 999)
            .run();
        await db.exec("ANALYZE studio_records");

        const indexes = await recordIndexStatements(
          db as unknown as D1Database,
          tenant,
          objectName,
          [],
          [{ fields: ["stage", "amount"], order: "ASC" }],
        );
        expect(indexes).toHaveLength(1);
        await db.batch(indexes);

        const stage = postgresDialect.jsonCompare(
          "data",
          "$.stage",
          "eq",
          "open",
        );
        const amountSort = postgresJsonSortParts("data", "$.amount");
        const sql = `EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) SELECT id FROM studio_records
        WHERE tenant_id=? AND object_name=? AND deleted_at IS NULL AND ${stage.sql}
        ORDER BY ${amountSort.map((part) => `(${part}) ASC`).join(",")},id ASC LIMIT 26`;
        const plan = await db
          .prepare(sql)
          .bind(tenant, objectName, ...stage.parameters)
          .all<{ "QUERY PLAN": string }>();
        const indexName = await recordIndexName(tenant, objectName, {
          fields: ["stage", "amount"],
          order: "ASC",
        });
        const firstPlan = plan.results
          .map((row) => row["QUERY PLAN"])
          .join("\n");
        expect(firstPlan).toContain(indexName);
        expect(firstPlan).not.toMatch(/\n\s+Sort\s/);
        expect(firstPlan).toMatch(
          /Index Scan using studio_perf_[a-f0-9]{40} on studio_records \(actual [^)]* rows=26 loops=1\)/,
        );

        const deepSelection = buildRecordPageSelection({
          source: "studio_records",
          where: `tenant_id=? AND object_name=? AND deleted_at IS NULL AND ${stage.sql}`,
          args: [tenant, objectName, ...stage.parameters],
          sortSql: postgresDialect.jsonSort("data", "$.amount"),
          sortName: "amount",
          order: "ASC",
          perPage: 25,
          offset: 0,
          cursor: {
            value: { rank: 1, number: "99000", text: "" },
            id: "record-99000",
          },
          sortParts: amountSort,
        });
        const deepPlan = await db
          .prepare(`EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) ${deepSelection.sql}`)
          .bind(...deepSelection.bindings)
          .all<{ "QUERY PLAN": string }>();
        const deepPlanText = deepPlan.results
          .map((row) => row["QUERY PLAN"])
          .join("\n");
        expect(deepPlanText).toContain(indexName);
        expect(deepPlanText).not.toContain("Seq Scan");
        expect(deepPlanText).not.toMatch(/Rows Removed by Filter: [1-9]/);
        const deepScanRows = Array.from(
          deepPlanText.matchAll(
            /Index Scan using studio_perf_[a-f0-9]{40} on studio_records(?: \S+)? \(actual [^)]* rows=(\d+) loops=\d+\)/g,
          ),
          (match) => Number(match[1]),
        );
        expect(deepScanRows).toHaveLength(2);
        expect(deepScanRows.every((rows) => rows <= 26)).toBe(true);

        const app = createStudioApp("record-index-test", {
          principalId: "record-index-user",
        });
        const page = async (cursor?: string) => {
          const query = new URLSearchParams({
            stage: "open",
            sort: "amount",
            order: "ASC",
            perPage: "25",
            ...(cursor ? { cursor } : {}),
          });
          const response = await app.request(
            `http://localhost/api/records/${objectName}?${query}`,
            {},
            { DB: db } as any,
          );
          expect(response.status).toBe(200);
          return response.json() as Promise<{
            data: Array<{ amount: number }>;
            nextCursor: string | null;
          }>;
        };
        const first = await page();
        expect(first.data.map((row) => row.amount)).toEqual(
          Array.from({ length: 25 }, (_, index) => index + 1),
        );
        expect(first.nextCursor).toBeTruthy();
        const second = await page(first.nextCursor!);
        expect(second.data.map((row) => row.amount)).toEqual(
          Array.from({ length: 25 }, (_, index) => index + 26),
        );

        const malformedPayload = JSON.parse(atob(first.nextCursor!));
        malformedPayload.value = "not-a-postgres-sort-key";
        const malformed = await app.request(
          `http://localhost/api/records/${objectName}?stage=open&sort=amount&order=ASC&perPage=25&cursor=${encodeURIComponent(btoa(JSON.stringify(malformedPayload)))}`,
          {},
          { DB: db } as any,
        );
        expect(malformed.status).toBe(422);
        malformedPayload.value = {
          rank: 1,
          number: "1e99999999",
          text: "",
        };
        const outOfRange = await app.request(
          `http://localhost/api/records/${objectName}?stage=open&sort=amount&order=ASC&perPage=25&cursor=${encodeURIComponent(btoa(JSON.stringify(malformedPayload)))}`,
          {},
          { DB: db } as any,
        );
        expect(outOfRange.status).toBe(422);
        malformedPayload.value = {
          rank: 2,
          number: "0",
          text: "bad\u0000text",
        };
        const invalidText = await app.request(
          `http://localhost/api/records/${objectName}?stage=open&sort=amount&order=ASC&perPage=25&cursor=${encodeURIComponent(btoa(JSON.stringify(malformedPayload)))}`,
          {},
          { DB: db } as any,
        );
        expect(invalidText.status).toBe(422);
        const wrongScope = await app.request(
          `http://localhost/api/records/${objectName}?stage=closed&sort=amount&order=ASC&perPage=25&cursor=${encodeURIComponent(first.nextCursor!)}`,
          {},
          { DB: db } as any,
        );
        expect(wrongScope.status).toBe(422);

        const mixedObject = "mixed_items";
        await createObject(db, tenant, {
          name: mixedObject,
          label: "Mixed items",
          config: {
            ...makeConfig({
              key: { type: "Textbox", label: "Key" },
              label: { type: "Textbox", label: "Label" },
              group_key: { type: "Textbox", label: "Group" },
            }),
            performance: {
              indexes: [
                { fields: ["key"], order: "ASC" },
                { fields: ["key"], order: "DESC" },
                { fields: ["group_key", "label", "key"], order: "ASC" },
              ],
              summaries: [],
            },
          },
        });
        const mixed = [
          { id: "missing-a", data: { label: "missing-a" } },
          { id: "missing-b", data: { label: "missing-b" } },
          { id: "null-a", data: { key: null, label: "null-a" } },
          { id: "number-negative", data: { key: -2, label: "negative" } },
          { id: "number-zero", data: { key: 0, label: "zero" } },
          { id: "boolean-false", data: { key: false, label: "false" } },
          { id: "number-one-a", data: { key: 1, label: "one-a" } },
          { id: "boolean-true", data: { key: true, label: "true" } },
          { id: "number-one-b", data: { key: 1, label: "one-b" } },
          { id: "number-decimal", data: { key: 1.5, label: "decimal" } },
          { id: "text-empty", data: { key: "", label: "empty" } },
          { id: "text-one", data: { key: "1", label: "text-one" } },
          { id: "text-alpha", data: { key: "alpha", label: "alpha" } },
        ];
        for (const row of mixed)
          await db
            .prepare(
              "INSERT INTO studio_records(id,tenant_id,object_name,data) VALUES (?,?,?,?)",
            )
            .bind(row.id, tenant, mixedObject, JSON.stringify(row.data))
            .run();
        const mixedPage = async (order: "ASC" | "DESC", cursor?: string) => {
          const query = new URLSearchParams({
            sort: "key",
            order,
            perPage: "2",
            ...(cursor ? { cursor } : {}),
          });
          const response = await app.request(
            `http://localhost/api/records/${mixedObject}?${query}`,
            {},
            { DB: db } as any,
          );
          expect(response.status).toBe(200);
          return response.json() as Promise<{
            data: Array<{ id: string }>;
            nextCursor: string | null;
          }>;
        };
        for (const order of ["ASC", "DESC"] as const) {
          const actual: string[] = [];
          let cursor: string | undefined;
          do {
            const result = await mixedPage(order, cursor);
            actual.push(...result.data.map((row) => row.id));
            cursor = result.nextCursor ?? undefined;
          } while (cursor);
          const expected = await db
            .prepare(
              `SELECT id FROM studio_records WHERE tenant_id=? AND object_name=? AND deleted_at IS NULL ORDER BY ${postgresJsonSortParts(
                "data",
                "$.key",
              )
                .map((part) => `(${part}) ${order}`)
                .join(",")},id ASC`,
            )
            .bind(tenant, mixedObject)
            .all<{ id: string }>();
          expect(actual).toEqual(expected.results.map((row) => row.id));
          if (order === "ASC") {
            expect(actual).toEqual([
              "missing-a",
              "missing-b",
              "null-a",
              "number-negative",
              "boolean-false",
              "number-zero",
              "boolean-true",
              "number-one-a",
              "number-one-b",
              "number-decimal",
              "text-empty",
              "text-one",
              "text-alpha",
            ]);
          }
        }
      });
    }, 180_000);
  },
);
