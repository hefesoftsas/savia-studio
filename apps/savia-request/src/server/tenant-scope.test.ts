import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { getPlatformProxy } from "wrangler";
import requestApp from "./index";
import {
  ensureExampleRequestBundleBundle,
  getFlow,
  getVariables,
  saveFlow,
  saveVariables,
} from "./store";
import type { Env } from "./env";

vi.mock("./provider-profile", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./provider-profile")>()),
  isBundleFlow: () => true,
}));

vi.mock("./catalog.json", async () => ({
  default: (await import("./bundle-test-fixture")).sampleBundleFlows,
}));
import { seal } from "./store";

let platform: Awaited<ReturnType<typeof getPlatformProxy<Env>>>;

const TENANT_A = "tenant:101";
const TENANT_B = "tenant:202";

async function applyMigrations() {
  for (const migration of readdirSync("migrations")
    .filter((file) => file.endsWith(".sql"))
    .sort()) {
    const statements = readFileSync("migrations/" + migration, "utf8")
      .split(";")
      .map((statement) =>
        statement.replace(/^.*--> statement-breakpoint.*$/gm, ""),
      )
      .filter((statement) => statement.trim());
    for (const statement of statements)
      await platform.env.DB.prepare(statement).run();
  }
}

beforeAll(async () => {
  platform = await getPlatformProxy({
    configPath: "wrangler.jsonc",
    persist: false,
  });
  await applyMigrations();
  (platform.env as unknown as Record<string, unknown>).ENCRYPTION_KEY =
    Buffer.alloc(32, 7).toString("base64");
});

beforeEach(async () => {
  await platform.env.DB.exec(
    "DELETE FROM flow_variables; DELETE FROM flows; DELETE FROM tenant_flows; DELETE FROM tenant_flow_variables; DELETE FROM tenant_flow_versions; DELETE FROM tenant_flow_runs; DELETE FROM flow_versions; DELETE FROM flow_runs; DELETE FROM folders; DELETE FROM tenant_folders;",
  );
});

afterAll(async () => {
  await platform?.dispose();
});

function insertGlobalFlow(id: string, name = id, folderPath = "Base") {
  return platform.env.DB.prepare("INSERT INTO flows(id,definition) VALUES(?,?)")
    .bind(
      id,
      JSON.stringify({
        id,
        name,
        description: "",
        steps: [
          {
            id: "s1",
            name: "paso",
            url: "https://provider.test/q",
            method: "GET",
            headers: {},
            body: "",
            pre: "",
            post: "",
          },
        ],
        input: {},
        variables: [],
        folderPath,
      }),
    )
    .run();
}

function call(method: string, path: string, body?: unknown, tenant?: string) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (tenant) headers["x-savia-tenant"] = tenant;
  return requestApp.fetch(
    new Request("https://savia-request.internal" + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    platform.env,
  );
}

describe("tenant scope", () => {
  it("rejects invalid tenant ids before touching storage", async () => {
    const response = await call("GET", "/api/flows", undefined, "agency/../x");
    expect(response.status).toBe(400);
  });

  it("keeps tenant definitions isolated with fallback to the platform catalog", async () => {
    await insertGlobalFlow("shared-flow", "Shared");
    // Tenant B sees the global definition.
    expect(await getFlow(platform.env, "shared-flow", TENANT_B)).toMatchObject({
      name: "Shared",
    });
    // Tenant A overrides only its own copy.
    await saveFlow(
      platform.env,
      {
        id: "shared-flow",
        name: "Shared A",
        description: "",
        steps: [
          {
            id: "s1",
            name: "paso",
            url: "https://a.test/q",
            method: "GET",
            headers: {},
            body: "",
            pre: "",
            post: "",
          },
        ],
        variables: [],
        input: {},
        folderPath: "A",
      },
      TENANT_A,
    );
    expect(await getFlow(platform.env, "shared-flow", TENANT_A)).toMatchObject({
      name: "Shared A",
      folderPath: "A",
    });
    expect(await getFlow(platform.env, "shared-flow", TENANT_B)).toMatchObject({
      name: "Shared",
    });
    expect(await getFlow(platform.env, "shared-flow", "")).toMatchObject({
      name: "Shared",
    });
    // Tenant A hides the flow without affecting the platform or tenant B.
    expect(
      await call("DELETE", "/api/flows/shared-flow", {}, TENANT_A),
    ).toMatchObject({ status: 200 });
    expect(await getFlow(platform.env, "shared-flow", TENANT_A)).toBeNull();
    expect(await getFlow(platform.env, "shared-flow", TENANT_B)).not.toBeNull();
    expect(await getFlow(platform.env, "shared-flow", "")).not.toBeNull();
    const listA = (await (
      await call("GET", "/api/flows", undefined, TENANT_A)
    ).json()) as { id: string }[];
    expect(listA.map((flow) => flow.id)).not.toContain("shared-flow");
  });

  it("merges variables per tenant without leaking platform secrets", async () => {
    await insertGlobalFlow("vars-flow");
    await platform.env.DB.batch([
      platform.env.DB.prepare(
        "INSERT INTO flow_variables(flow_id,key,value,secret) VALUES(?,?,?,?)",
      ).bind("vars-flow", "endpoint", "https://global.test", 0),
      platform.env.DB.prepare(
        "INSERT INTO flow_variables(flow_id,key,value,secret) VALUES(?,?,?,?)",
      ).bind(
        "vars-flow",
        "api_token",
        await seal(platform.env, "global-s3cr3t"),
        1,
      ),
    ]);
    // Tenant sees the endpoint default but never the platform secret value.
    const masked = await getVariables(
      platform.env,
      "vars-flow",
      false,
      TENANT_A,
    );
    expect(masked).toContainEqual({
      key: "endpoint",
      secret: false,
      configured: true,
      overridden: false,
      hasPlatformDefault: true,
      value: "https://global.test",
    });
    expect(masked).toContainEqual({
      key: "api_token",
      secret: true,
      configured: true,
      overridden: false,
      hasPlatformDefault: true,
      value: "",
    });
    const revealed = await getVariables(
      platform.env,
      "vars-flow",
      true,
      TENANT_A,
    );
    expect(revealed.find((v) => v.key === "api_token")).toMatchObject({
      value: "",
    });
    // Reveal endpoint also stays tenant-scoped: platform secret unreachable.
    expect(
      await (
        await call(
          "POST",
          "/api/flows/vars-flow/variables/reveal",
          { key: "api_token" },
          TENANT_A,
        )
      ).json(),
    ).toEqual({ value: "" });
    // Tenant configures its own values; an empty secret keeps the fallback.
    await saveVariables(
      platform.env,
      "vars-flow",
      [
        { key: "endpoint", value: "https://a.test", secret: false },
        { key: "api_token", value: "tenant-s3cr3t", secret: true },
      ],
      TENANT_A,
    );
    const effective = await getVariables(
      platform.env,
      "vars-flow",
      true,
      TENANT_A,
    );
    expect(effective.find((v) => v.key === "endpoint")).toMatchObject({
      value: "https://a.test",
    });
    expect(effective.find((v) => v.key === "api_token")).toMatchObject({
      value: "tenant-s3cr3t",
    });
    // Other tenant and platform are unaffected.
    expect(
      (await getVariables(platform.env, "vars-flow", true, TENANT_B)).find(
        (v) => v.key === "endpoint",
      ),
    ).toMatchObject({ value: "https://global.test" });
    expect(
      (await getVariables(platform.env, "vars-flow", true, "")).find(
        (v) => v.key === "api_token",
      ),
    ).toMatchObject({ value: "global-s3cr3t" });
    // Saving a masked secret back does not create an empty override.
    await saveVariables(
      platform.env,
      "vars-flow",
      [
        { key: "endpoint", value: "https://b.test", secret: false },
        { key: "api_token", value: "", secret: true },
      ],
      TENANT_B,
    );
    const bPrivate = await getVariables(
      platform.env,
      "vars-flow",
      true,
      TENANT_B,
    );
    expect(bPrivate.find((v) => v.key === "endpoint")).toMatchObject({
      value: "https://b.test",
    });
    expect(bPrivate.find((v) => v.key === "api_token")).toMatchObject({
      value: "",
    });
    const overlayRows = await platform.env.DB.prepare(
      "SELECT key FROM tenant_flow_variables WHERE tenant_id=? AND flow_id=? ORDER BY key",
    )
      .bind(TENANT_B, "vars-flow")
      .all<{ key: string }>();
    expect(overlayRows.results.map((row) => row.key)).toEqual(["endpoint"]);
  });

  it.each([
    { name: "platform", owner: undefined, editor: undefined },
    { name: "tenant-owned", owner: TENANT_A, editor: TENANT_A },
    { name: "inherited", owner: undefined, editor: TENANT_A },
  ])(
    "requires a replacement before clearing a $name secret flag",
    async ({ owner, editor }) => {
      const flowId = "secret-replacement";
      const path = `/api/flows/${flowId}/variables`;
      await insertGlobalFlow(flowId);
      await saveVariables(
        platform.env,
        flowId,
        [
          { key: "endpoint", value: "https://original.test", secret: false },
          { key: "token", value: "fixture-token", secret: true },
        ],
        owner,
      );

      const edited = { key: "endpoint", value: "", secret: false };
      const rejected = await call(
        "PUT",
        path,
        [edited, { key: "token", value: "", secret: false }],
        editor,
      );
      expect(rejected.status).toBe(400);
      expect(await rejected.json()).toEqual({
        error: "Para desmarcar un secreto debes reemplazar su valor.",
      });
      expect(
        await getVariables(platform.env, flowId, true, editor, true),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ...edited,
            value: "https://original.test",
          }),
          expect.objectContaining({
            key: "token",
            value: "fixture-token",
            secret: true,
          }),
        ]),
      );

      const replacement = {
        key: "token",
        value: "public-fixture",
        secret: false,
      };
      expect(
        (await call("PUT", path, [edited, replacement], editor)).status,
      ).toBe(200);
      expect(await getVariables(platform.env, flowId, false, editor)).toEqual(
        expect.arrayContaining([
          expect.objectContaining(edited),
          expect.objectContaining(replacement),
        ]),
      );
      if (!owner && editor) {
        expect(await getVariables(platform.env, flowId, true)).toContainEqual(
          expect.objectContaining({
            key: "token",
            value: "fixture-token",
            secret: true,
          }),
        );
      }
    },
  );

  it.each([undefined, TENANT_A])(
    "requires a replacement when making a configured public variable secret in %s",
    async (tenant) => {
      const flowId = "protect-public-variable";
      const path = `/api/flows/${flowId}/variables`;
      await insertGlobalFlow(flowId);
      await saveVariables(platform.env, flowId, [
        { key: "label", value: "existing-fixture", secret: false },
      ]);

      const failed = await call(
        "PUT",
        path,
        [{ key: "label", value: "", secret: true }],
        tenant,
      );
      expect(failed.status).toBe(400);
      expect(await failed.json()).toEqual({
        error:
          "Para marcar una variable como secreta debes reemplazar su valor.",
      });
      expect(
        await getVariables(platform.env, flowId, true, tenant),
      ).toContainEqual(
        expect.objectContaining({
          key: "label",
          value: "existing-fixture",
          secret: false,
        }),
      );

      const saved = await call(
        "PUT",
        path,
        [{ key: "label", value: "private-fixture", secret: true }],
        tenant,
      );
      expect(saved.status).toBe(200);
      expect(await saved.json()).toMatchObject({
        variables: [
          expect.objectContaining({
            key: "label",
            value: "",
            secret: true,
            configured: true,
          }),
        ],
      });
      expect(
        await getVariables(platform.env, flowId, true, tenant),
      ).toContainEqual(
        expect.objectContaining({
          key: "label",
          value: "private-fixture",
          secret: true,
        }),
      );
    },
  );

  it("keeps a new unconfigured tenant secret available in the saved variables", async () => {
    const flowId = "tenant-secret-field";
    await insertGlobalFlow(flowId);
    const response = await call(
      "PUT",
      `/api/flows/${flowId}/variables`,
      [{ key: "token", value: "", secret: true }],
      TENANT_A,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      variables: [
        {
          key: "token",
          value: "",
          secret: true,
          configured: false,
          overridden: true,
          hasPlatformDefault: false,
        },
      ],
    });
  });

  it("resolves empty overrides according to the effective variable's secrecy", async () => {
    const flowId = "legacy-variable-override";
    await insertGlobalFlow(flowId);
    await saveVariables(platform.env, flowId, [
      { key: "label", value: "public-label", secret: false },
      { key: "token", value: "public-token", secret: false },
      { key: "inherited_secret", value: "inherited-fixture", secret: true },
    ]);
    await platform.env.DB.batch(
      [
        ["label", 0],
        ["token", 1],
        ["inherited_secret", 1],
      ].map(([key, secret]) =>
        platform.env.DB.prepare(
          "INSERT INTO tenant_flow_variables(tenant_id,flow_id,key,value,secret,updated_at) VALUES(?,?,?,?,?,?)",
        ).bind(TENANT_A, flowId, key, "", secret, new Date().toISOString()),
      ),
    );

    expect(
      await getVariables(platform.env, flowId, true, TENANT_A, true),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "label",
          secret: false,
          value: "",
          configured: false,
        }),
        expect.objectContaining({
          key: "token",
          secret: true,
          value: "",
          configured: false,
        }),
        expect.objectContaining({
          key: "inherited_secret",
          secret: true,
          value: "inherited-fixture",
          configured: true,
        }),
      ]),
    );
    expect(
      await getVariables(platform.env, flowId, true, TENANT_A),
    ).toContainEqual(
      expect.objectContaining({
        key: "inherited_secret",
        value: "",
        configured: true,
      }),
    );
  });

  it.each([undefined, TENANT_A])(
    "commits the definition and variables together in %s",
    async (tenant) => {
      const id = "atomic-save";
      const path = `/api/flows/${id}/variables`;
      await insertGlobalFlow(id, "Original");
      const original = (await getFlow(platform.env, id))!;
      await saveVariables(platform.env, id, [
        { key: "token", value: "saved-fixture", secret: true },
      ]);
      const draft = { ...original, name: "Updated" };

      const rejected = await call(
        "PUT",
        path,
        {
          flow: draft,
          variables: [{ key: "token", value: "", secret: false }],
        },
        tenant,
      );
      expect(rejected.status).toBe(400);
      expect(await rejected.json()).toEqual({
        error: "Para desmarcar un secreto debes reemplazar su valor.",
      });
      expect(await getFlow(platform.env, id, tenant)).toMatchObject({
        name: "Original",
      });
      expect(
        await getVariables(platform.env, id, true, tenant, true),
      ).toContainEqual(
        expect.objectContaining({
          key: "token",
          secret: true,
          value: "saved-fixture",
        }),
      );

      const saved = await call(
        "PUT",
        path,
        {
          flow: draft,
          variables: [
            { key: "token", value: "replacement-fixture", secret: true },
          ],
        },
        tenant,
      );
      expect(saved.status).toBe(200);
      expect(await saved.json()).toMatchObject({
        ok: true,
        variables: [
          expect.objectContaining({
            key: "token",
            value: "",
            configured: true,
          }),
        ],
      });
      expect(await getFlow(platform.env, id, tenant)).toMatchObject({
        name: "Updated",
      });
      expect(
        await getVariables(platform.env, id, true, tenant, true),
      ).toContainEqual(
        expect.objectContaining({
          key: "token",
          secret: true,
          value: "replacement-fixture",
        }),
      );
      if (tenant)
        expect(await getFlow(platform.env, id)).toMatchObject({
          name: "Original",
        });
    },
  );

  describe.each(["definition", "definition and variables"])(
    "flow save with %s",
    (mode) => {
      const id = "flow-validation";
      const path = `/api/flows/${id}${mode === "definition" ? "" : "/variables"}`;

      it("returns a JSON error for a malformed body", async () => {
        const response = await requestApp.fetch(
          new Request(`https://savia-request.internal${path}`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: "{",
          }),
          platform.env,
        );

        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({
          error: "Envía un cuerpo JSON válido.",
        });
      });

      it.each([
        { field: "name", value: 12, error: "Indica un nombre para el flujo." },
        {
          field: "input",
          value: [],
          error:
            "La entrada del flujo debe ser un objeto con valores de texto.",
        },
        {
          field: "steps",
          value: [null],
          error: "El paso 1 debe ser un objeto.",
        },
      ])(
        "identifies an invalid $field without saving",
        async ({ field, value, error }) => {
          await insertGlobalFlow(id, "Original");
          const original = (await getFlow(platform.env, id))!;
          const draft = { ...original, name: "Updated", [field]: value };
          const variables = [
            { key: "endpoint", value: "fixture", secret: false },
          ];
          const body =
            mode === "definition" ? draft : { flow: draft, variables };

          const response = await call("PUT", path, body, TENANT_A);

          expect(response.status).toBe(400);
          expect(await response.json()).toEqual({ error });
          expect(await getFlow(platform.env, id, TENANT_A)).toMatchObject({
            name: "Original",
            customized: false,
          });
          expect(await getVariables(platform.env, id, false, TENANT_A)).toEqual(
            [],
          );
        },
      );

      it.each([
        {
          reason: "method",
          method: "POST",
          cache: { enabled: true, scope: "tenant", ttlSeconds: 60 },
          error: "El paso 1 solo admite caché con GET o HEAD.",
        },
        {
          reason: "duration",
          method: "GET",
          cache: { enabled: true, scope: "tenant", ttlSeconds: 0 },
          error: "Revisa la configuración de caché del paso 1.",
        },
        {
          reason: "scope",
          method: "GET",
          cache: { enabled: true, scope: "connection", ttlSeconds: 60 },
          error:
            "Usa caché de tenant en el paso 1 para un flujo sin conexión asociada.",
        },
      ])(
        "returns the affected step and cache $reason error as JSON",
        async ({ method, cache, error }) => {
          await insertGlobalFlow(id);
          const original = (await getFlow(platform.env, id))!;
          const draft = {
            ...original,
            steps: [
              {
                ...original.steps[0],
                method,
                cache,
              },
            ],
          };
          const body =
            mode === "definition" ? draft : { flow: draft, variables: [] };

          const response = await call("PUT", path, body, TENANT_A);

          expect(response.status).toBe(400);
          expect(await response.json()).toEqual({ error });
        },
      );
    },
  );

  it("rejects a variable whose key is missing", async () => {
    const id = "variable-validation";
    await insertGlobalFlow(id);

    const response = await call(
      "PUT",
      `/api/flows/${id}/variables`,
      [{ value: "fixture", secret: false }],
      TENANT_A,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Variables inválidas o claves duplicadas.",
    });
    expect(await getVariables(platform.env, id, false, TENANT_A)).toEqual([]);
  });

  it("rolls back the flow definition when a variable write fails inside the batch", async () => {
    const id = "atomic-save-rollback";
    await insertGlobalFlow(id, "Original");
    const flow = (await getFlow(platform.env, id))!;
    await platform.env.DB.prepare(
      "CREATE TRIGGER fail_variable_write BEFORE INSERT ON tenant_flow_variables WHEN NEW.key='fail-on-write' BEGIN SELECT RAISE(ABORT, 'fixture variable write failed'); END",
    ).run();
    try {
      const response = await call(
        "PUT",
        `/api/flows/${id}/variables`,
        {
          flow: { ...flow, name: "Updated" },
          variables: [
            { key: "fail-on-write", value: "fixture", secret: false },
          ],
        },
        TENANT_A,
      );
      expect(response.status).toBe(500);
      expect(await getFlow(platform.env, id, TENANT_A)).toMatchObject({
        name: "Original",
        customized: false,
      });
      expect(await getVariables(platform.env, id, false, TENANT_A)).toEqual([]);
    } finally {
      await platform.env.DB.prepare("DROP TRIGGER fail_variable_write").run();
    }
  });

  it("acknowledges variable writes using the stored masked configuration", async () => {
    const flowId = "masked-acknowledgement";
    await insertGlobalFlow(flowId);
    await saveVariables(platform.env, flowId, [
      { key: "endpoint", value: "https://platform.test", secret: false },
    ]);
    const saved = await call(
      "PUT",
      `/api/flows/${flowId}/variables`,
      [{ key: "token", value: "tenant-fixture", secret: true }],
      TENANT_A,
    );

    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({
      ok: true,
      variables: [
        {
          key: "endpoint",
          value: "https://platform.test",
          secret: false,
          configured: true,
          overridden: false,
          hasPlatformDefault: true,
        },
        {
          key: "token",
          value: "",
          secret: true,
          configured: true,
          overridden: true,
          hasPlatformDefault: false,
        },
      ],
    });
  });

  it("keeps inherited secret keys available for configuration when a tenant duplicates a flow", async () => {
    const flowId = "duplicate-variables";
    await insertGlobalFlow(flowId);
    await saveVariables(platform.env, flowId, [
      { key: "endpoint", value: "https://example.test", secret: false },
      { key: "platform_token", value: "platform-fixture", secret: true },
    ]);
    await saveVariables(
      platform.env,
      flowId,
      [{ key: "tenant_token", value: "tenant-fixture", secret: true }],
      TENANT_A,
    );

    const response = await call(
      "POST",
      `/api/flows/${flowId}/duplicate`,
      {},
      TENANT_A,
    );
    expect(response.status).toBe(201);
    const { id } = await response.json<{ id: string }>();
    expect(
      await getVariables(platform.env, id, false, TENANT_A),
    ).toContainEqual({
      key: "platform_token",
      value: "",
      secret: true,
      configured: false,
      overridden: true,
      hasPlatformDefault: false,
    });
    expect(await getVariables(platform.env, id, true, TENANT_A, true)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "platform_token",
          value: "",
          secret: true,
        }),
        expect.objectContaining({
          key: "tenant_token",
          value: "tenant-fixture",
          secret: true,
        }),
        expect.objectContaining({
          key: "endpoint",
          value: "https://example.test",
          secret: false,
        }),
      ]),
    );
    expect(await getFlow(platform.env, id, TENANT_B)).toBeNull();
    const copyVariables = await getVariables(platform.env, id, false, TENANT_A);
    const saved = await call(
      "PUT",
      `/api/flows/${id}/variables`,
      copyVariables.map((variable) =>
        variable.key === "platform_token"
          ? { ...variable, value: "copy-fixture" }
          : variable,
      ),
      TENANT_A,
    );
    expect(saved.status).toBe(200);
    expect(
      await getVariables(platform.env, id, true, TENANT_A, true),
    ).toContainEqual(
      expect.objectContaining({
        key: "platform_token",
        value: "copy-fixture",
        secret: true,
      }),
    );
    expect(await getVariables(platform.env, flowId, true)).toContainEqual(
      expect.objectContaining({
        key: "platform_token",
        value: "platform-fixture",
        secret: true,
      }),
    );
  });

  it("isolates versions and runs per tenant with platform fallback", async () => {
    await insertGlobalFlow("versioned-flow");
    const published = await (
      await call("POST", "/api/flows/versioned-flow/publish", {}, TENANT_A)
    ).json<{ id: string }>();
    expect(published.id).toEqual(expect.any(String));
    // Tenant run history does not leak into the platform scope and vice versa.
    const runResponse = await call(
      "POST",
      "/api/flows/versioned-flow/runs",
      { mode: "mock", input: {} },
      TENANT_A,
    );
    expect(runResponse.status).toBe(200);
    expect(
      (await (
        await call("GET", "/api/flows/versioned-flow/runs", undefined, TENANT_A)
      ).json()) as unknown[],
    ).toHaveLength(1);
    expect(
      (await (
        await call("GET", "/api/flows/versioned-flow/runs")
      ).json()) as unknown[],
    ).toHaveLength(0);
    // Published v1 execution prefers the tenant version.
    const v1 = await call(
      "POST",
      "/v1/flows/versioned-flow/runs",
      { mode: "mock", input: {} },
      TENANT_A,
    );
    expect(v1.status).toBe(200);
    // Tenant B without its own version falls back to the platform version.
    await call("POST", "/api/flows/versioned-flow/publish", {});
    const fallback = await call(
      "POST",
      "/v1/flows/versioned-flow/runs",
      { mode: "mock", input: {} },
      TENANT_B,
    );
    expect(fallback.status).toBe(200);
  });

  it("unions folders across scopes and deletes only in scope", async () => {
    await call("POST", "/api/folders", { path: "Global" });
    await call("POST", "/api/folders", { path: "Solo A" }, TENANT_A);
    const foldersA = (await (
      await call("GET", "/api/folders", undefined, TENANT_A)
    ).json()) as string[];
    expect(foldersA).toEqual(expect.arrayContaining(["Global", "Solo A"]));
    const foldersB = (await (
      await call("GET", "/api/folders", undefined, TENANT_B)
    ).json()) as string[];
    expect(foldersB).toContain("Global");
    expect(foldersB).not.toContain("Solo A");
    await call("DELETE", "/api/folders", { path: "Solo A" }, TENANT_A);
    expect(
      (await (
        await call("GET", "/api/folders", undefined, TENANT_A)
      ).json()) as string[],
    ).not.toContain("Solo A");
    expect(
      (await (await call("GET", "/api/folders")).json()) as string[],
    ).toContain("Global");
  });

  it("installs the bundled requests per tenant without touching globals", async () => {
    const installed = await ensureExampleRequestBundleBundle(
      platform.env,
      TENANT_A,
    );
    expect(installed.flowIds).toContain("sample-provider-lookup");
    // Global catalog untouched until the platform itself installs.
    expect(
      await getFlow(platform.env, "sample-provider-lookup", ""),
    ).toBeNull();
    expect(
      await getFlow(platform.env, "sample-provider-lookup", TENANT_A),
    ).not.toBeNull();
    expect(
      await getFlow(platform.env, "sample-provider-lookup", TENANT_B),
    ).toBeNull();
    const bundleRow = await platform.env.DB.prepare(
      "SELECT version FROM tenant_bundles WHERE tenant_id=? AND id=?",
    )
      .bind(TENANT_A, "example-request-bundle")
      .first<{ version: string }>();
    expect(bundleRow).toMatchObject({ version: "1.1.0" });
  }, 30_000);

  it("exports only the requesting scope", async () => {
    await insertGlobalFlow("export-flow");
    await saveVariables(
      platform.env,
      "export-flow",
      [{ key: "endpoint", value: "https://a.test", secret: false }],
      TENANT_A,
    );
    const body = (await (
      await call("GET", "/api/variables/export", undefined, TENANT_A)
    ).json()) as { tenant: string; flows: { flowId: string }[] };
    expect(body.tenant).toBe(TENANT_A);
    expect(body.flows.map((flow) => flow.flowId)).toContain("export-flow");
    const platformBody = (await (
      await call("GET", "/api/variables/export")
    ).json()) as { flows: { flowId: string }[] };
    expect(platformBody.flows.map((flow) => flow.flowId)).not.toContain(
      "export-flow",
    );
  }, 30_000);
}, 30_000);
