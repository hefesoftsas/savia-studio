import test from "node:test";
import assert from "node:assert/strict";
import {
  assertRuntimeBindings,
  expectedPreviewCodeOnlyWorkers,
} from "./runtime-bindings.mjs";

test("gateway cannot enter the source-only lane even with well-formed metadata", () => {
  assert.throws(
    () =>
      expectedPreviewCodeOnlyWorkers({
        version: 1,
        sourceRevision: "b".repeat(40),
        codeOnly: {
          base: "a".repeat(40),
          head: "b".repeat(40),
          targets: ["gateway"],
        },
      }),
    /scope/,
  );
});

test("frontend Preview code scope resolves gateway and plugin editor to exact Workers as a pair", () => {
  const revision = "b".repeat(40);
  const releaseSource = {
    version: 1,
    sourceRevision: revision,
    codeOnly: {
      base: "a".repeat(40),
      head: revision,
      targets: ["gateway", "pluginEditor"],
    },
  };
  assert.deepEqual(expectedPreviewCodeOnlyWorkers(releaseSource), [
    "savia-plugin-editor-preview",
    "savia-preview",
  ]);
  assert.deepEqual(
    expectedPreviewCodeOnlyWorkers({
      ...releaseSource,
      codeOnly: {
        ...releaseSource.codeOnly,
        targets: ["gateway", "pluginEditor", "api", "mcp"],
      },
    }),
    [
      "savia-agencies-preview",
      "savia-mcp-preview",
      "savia-plugin-editor-preview",
      "savia-preview",
    ],
  );
  for (const targets of [
    ["gateway"],
    ["pluginEditor"],
    ["gateway", "pluginEditor", "auth"],
    ["gateway", "api"],
  ])
    assert.throws(
      () =>
        expectedPreviewCodeOnlyWorkers({
          ...releaseSource,
          codeOnly: { ...releaseSource.codeOnly, targets },
        }),
      /scope/,
    );
});

test("assistant API/MCP scope inventories exactly their two Preview Workers", () => {
  const revision = "b".repeat(40);
  assert.deepEqual(
    expectedPreviewCodeOnlyWorkers({
      version: 1,
      sourceRevision: revision,
      codeOnly: {
        base: "a".repeat(40),
        head: revision,
        targets: ["mcp", "api"],
      },
    }),
    ["savia-agencies-preview", "savia-mcp-preview"],
  );
});
const inputs = {
  accountId: "a".repeat(32),
  environment: "preview",
  workers: [{ name: "savia-preview" }, { name: "savia-agencies-preview" }],
  adoptionManifest: {
    profile: {},
    resources: [
      {
        kind: "d1",
        name: "savia-agencies-preview",
        cloudId: "domain-preview-id",
      },
      {
        kind: "r2",
        name: "savia-documents-preview",
        cloudId: "savia-documents-preview",
      },
    ],
  },
};
const configs = [
  {
    name: "savia-preview",
    services: [{ binding: "API", service: "savia-agencies-preview" }],
    routes: [{ custom_domain: true, pattern: "savia-preview.hefesoft.com" }],
  },
  {
    name: "savia-agencies-preview",
    d1_databases: [{ binding: "DB", database_id: "domain-preview-id" }],
    r2_buckets: [{ binding: "DOCS", bucket_name: "savia-documents-preview" }],
    durable_objects: {
      bindings: [{ name: "REALTIME", class_name: "RealtimeHub" }],
    },
  },
];
test("frozen bindings stay inside the selected environment and existing data identities", () => {
  assert.equal(assertRuntimeBindings(inputs, configs), true);
  for (const mutate of [
    (rows) => (rows[0].services[0].service = "savia-agencies"),
    (rows) => (rows[1].d1_databases[0].database_id = "production-id"),
    (rows) =>
      (rows[1].r2_buckets[0].bucket_name = "savia-pulumi-state-preview"),
    (rows) => (rows[0].routes[0].pattern = "savia.hefesoft.com"),
    (rows) =>
      (rows[1].durable_objects.bindings[0].script_name = "savia-agencies"),
  ]) {
    const wrong = structuredClone(configs);
    mutate(wrong);
    assert.throws(
      () => assertRuntimeBindings(inputs, wrong),
      /environment|binding|identity|target/i,
    );
  }
  assert.throws(
    () => assertRuntimeBindings(inputs, configs.slice(1)),
    /missing|profile/i,
  );
});

test("Flows opt-out allows only its missing bundle without dropping the live API binding", () => {
  const flows = "savia-flows-preview";
  const preview = { ...inputs, workers: [...inputs.workers, { name: flows }] };
  const core = structuredClone(configs);
  core[1].services = [{ binding: "SAVIA_FLOWS", service: flows }];
  const options = { skipPreviewFlows: true };
  assert.equal(assertRuntimeBindings(preview, core, options), true);
  assert.equal(
    assertRuntimeBindings(preview, [...core, { name: flows }], options),
    true,
  );
  assert.throws(() => assertRuntimeBindings(preview, core), /missing/i);
  assert.throws(
    () => assertRuntimeBindings(preview, core.slice(1), options),
    /missing/i,
  );
  assert.throws(
    () => assertRuntimeBindings(inputs, core, options),
    /crosses environment/i,
  );
  assert.throws(
    () =>
      assertRuntimeBindings(
        {
          ...inputs,
          environment: "production",
          workers: [{ name: "savia-agencies" }, { name: "savia-flows" }],
          adoptionManifest: { profile: {}, resources: [] },
        },
        [
          {
            name: "savia-agencies",
            services: [{ binding: "SAVIA_FLOWS", service: "savia-flows" }],
          },
        ],
        options,
      ),
    /missing/i,
  );
});

test("verified Preview code scope allows exactly selected configs while checking bindings against full ownership", () => {
  const partial = [configs[1]],
    revision = "b".repeat(40),
    verifiedScope = {
      releaseSource: {
        version: 1,
        sourceRevision: revision,
        codeOnly: {
          base: "a".repeat(40),
          head: revision,
          targets: ["api"],
        },
      },
    };
  assert.equal(assertRuntimeBindings(inputs, partial, verifiedScope), true);
  const wrongIdentity = structuredClone(partial);
  wrongIdentity[0].d1_databases[0].database_id = "production-id";
  assert.throws(
    () =>
      assertRuntimeBindings(inputs, wrongIdentity, {
        ...verifiedScope,
      }),
    /identity/,
  );
  assert.throws(
    () =>
      assertRuntimeBindings(inputs, [...configs], {
        ...verifiedScope,
      }),
    /scope|selected|extra/i,
  );
  assert.throws(
    () => assertRuntimeBindings(inputs, partial),
    /missing|profile/i,
  );
  assert.throws(
    () =>
      assertRuntimeBindings(inputs, partial, {
        releaseSource: {
          ...verifiedScope.releaseSource,
          codeOnly: {
            ...verifiedScope.releaseSource.codeOnly,
            targets: ["unknown"],
          },
        },
      }),
    /scope/i,
  );
});

test("the existing branch renderer's two local classes fit its environment catalog", async () => {
  const { workerConfig } = await import("./runtime-publisher-branch.mjs"),
    { previewNames } = await import("../../scripts/preview-environment.mjs");
  const names = previewNames("feature-login"),
    ids = { auth: "auth-id", domain: "domain-id" };
  const inputs = {
    accountId: "a".repeat(32),
    environment: "branch-feature-login",
    workers: Object.values(names.workers).map((name) => ({ name })),
    adoptionManifest: {
      profile: {},
      resources: [
        { kind: "d1", name: names.databases.auth, cloudId: ids.auth },
        { kind: "d1", name: names.databases.domain, cloudId: ids.domain },
        { kind: "r2", name: names.bucket, cloudId: names.bucket },
      ],
    },
  };
  const configs = Object.keys(names.workers).map((role) =>
    workerConfig(
      role,
      names,
      ids,
      "https://savia-preview-feature-login.fixture.workers.dev",
    ),
  );
  assert.equal(assertRuntimeBindings(inputs, configs), true);
});
