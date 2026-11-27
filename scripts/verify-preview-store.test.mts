import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  evaluatePreviewStore,
  parseExcludedTenants,
  verifyPreviewStore,
} from "./verify-preview-store.mts";

const requiredBytes = Buffer.from("required release zip");
const optionalBytes = Buffer.from("optional release zip");
const requiredManifest = {
  format: "savia.extension",
  formatVersion: 1,
  id: "hosted.required",
  version: "1.2.3",
  label: "Required",
  description: "",
  requires: [],
  apiVersion: 1,
};
const optionalManifest = {
  ...requiredManifest,
  id: "hosted.optional",
  version: "2.0.0",
};
const requiredStore = {
  format: "savia.store",
  formatVersion: 1,
  actions: [],
  connectors: [],
  collections: [
    {
      object: {
        name: "primary_records",
        label: "Primary records",
        description: "",
        config: {
          version: 2,
          fields: { name: { type: "Textbox", label: "Name", required: true } },
          fieldOrder: ["name"],
        },
      },
      requiredFields: { name: { types: ["Textbox"], required: true } },
    },
    {
      object: {
        name: "secondary_records",
        label: "Secondary records",
        description: "",
        config: {
          version: 2,
          fields: { code: { type: "Textbox", label: "Code" } },
          fieldOrder: ["code"],
        },
      },
      requiredFields: { code: { types: ["Textbox"] } },
    },
  ],
  bundles: [],
  widgets: [],
  screens: [],
};
const artifacts = [
  {
    manifest: requiredManifest,
    optional: false,
    bytes: requiredBytes,
    storeJson: requiredStore,
  },
  ...Array.from({ length: 24 }, (_, index) => ({
    manifest: { ...optionalManifest, id: `hosted.optional-${index + 1}` },
    optional: true,
    bytes: Buffer.from(`${optionalBytes.toString()}:${index + 1}`),
    storeJson: null,
  })),
];
const artifactDigests = artifacts.map((artifact) =>
  createHash("sha256").update(artifact.bytes).digest("hex"),
);
const tenants = ["tenant:1", "tenant:2"];

function snapshot(overrides: Partial<Record<string, unknown>> = {}) {
  const catalog = tenants.flatMap((tenant) =>
    artifacts.map((artifact, index) => ({
      tenant_id: tenant,
      id: artifact.manifest.id,
      version: artifact.manifest.version,
      manifest: JSON.stringify(artifact.manifest),
      sha256: artifactDigests[index],
      store_json: artifact.optional ? null : JSON.stringify(requiredStore),
    })),
  );
  const installations = tenants.map((tenant) => ({
    tenant_id: tenant,
    id: requiredManifest.id,
    version: "1.2.3",
    enabled: 1,
    manifest: JSON.stringify(requiredManifest),
  }));
  const objects = tenants.flatMap((tenant) => [
    {
      tenant_id: tenant,
      name: "primary_records",
      label: "Primary records",
      description: "",
      config: JSON.stringify(requiredStore.collections[0].object.config),
      version: 1,
    },
    {
      tenant_id: tenant,
      name: "secondary_records",
      label: "Secondary records",
      description: "",
      config: JSON.stringify(requiredStore.collections[1].object.config),
      version: 1,
    },
  ]);
  return { tenants, catalog, installations, objects, ...overrides };
}

test("accepts an exact live catalog with one installed required ZIP and optional ZIPs", () => {
  assert.equal(
    evaluatePreviewStore({
      artifacts,
      snapshot: snapshot(),
      excludedTenants: [],
    }),
    true,
  );
});

test("checks newly added eligible tenants and ignores configured exclusions", () => {
  const expanded = snapshot({ tenants: ["tenant:1", "tenant:2", "tenant:3"] });
  assert.equal(
    evaluatePreviewStore({
      artifacts,
      snapshot: expanded,
      excludedTenants: [],
    }),
    false,
  );
  const excludedSnapshot = { ...expanded, tenants: ["tenant:1", "tenant:2"] };
  assert.equal(
    evaluatePreviewStore({
      artifacts,
      snapshot: excludedSnapshot,
      excludedTenants: ["tenant:3"],
    }),
    true,
  );
});

test("returns false for missing or mismatched exact artifact bytes", () => {
  const changed = snapshot();
  changed.catalog[0].sha256 = "0".repeat(64);
  assert.equal(
    evaluatePreviewStore({ artifacts, snapshot: changed, excludedTenants: [] }),
    false,
  );
  const missing = snapshot();
  missing.catalog = missing.catalog.filter(
    (row) => row.id !== artifacts[1].manifest.id,
  );
  assert.equal(
    evaluatePreviewStore({ artifacts, snapshot: missing, excludedTenants: [] }),
    false,
  );
});

test("accepts tenant:0 as an eligible tenant but never as an exclusion scope", () => {
  const current = snapshot();
  current.tenants = ["tenant:0", "tenant:2"];
  for (const rows of [
    current.catalog,
    current.installations,
    current.objects,
  ]) {
    for (const row of rows)
      if (row.tenant_id === "tenant:1") row.tenant_id = "tenant:0";
  }
  assert.equal(
    evaluatePreviewStore({ artifacts, snapshot: current, excludedTenants: [] }),
    true,
  );
  assert.throws(() => parseExcludedTenants("tenant:0"));
});

test("returns false when the required installation or either collection drifts", () => {
  const disabled = snapshot();
  disabled.installations[0].enabled = 0;
  assert.equal(
    evaluatePreviewStore({
      artifacts,
      snapshot: disabled,
      excludedTenants: [],
    }),
    false,
  );
  const missingCollection = snapshot();
  missingCollection.objects = missingCollection.objects.filter(
    (row) => row.name !== "secondary_records",
  );
  assert.equal(
    evaluatePreviewStore({
      artifacts,
      snapshot: missingCollection,
      excludedTenants: [],
    }),
    false,
  );
  const incompatible = snapshot();
  incompatible.objects[0].config = JSON.stringify({
    fields: { name: { type: "Number", required: true } },
  });
  assert.equal(
    evaluatePreviewStore({
      artifacts,
      snapshot: incompatible,
      excludedTenants: [],
    }),
    false,
  );
  const changedRequiredConfig = snapshot();
  changedRequiredConfig.catalog[0].store_json = JSON.stringify({
    ...requiredStore,
    collections: [],
  });
  assert.equal(
    evaluatePreviewStore({
      artifacts,
      snapshot: changedRequiredConfig,
      excludedTenants: [],
    }),
    false,
  );
});

test("returns false for a newer catalog artifact even when the desired version remains present", () => {
  const newer = snapshot();
  newer.catalog.push({
    ...newer.catalog[1],
    version: "2.0.1",
    manifest: JSON.stringify({ ...artifacts[1].manifest, version: "2.0.1" }),
  });
  assert.equal(
    evaluatePreviewStore({ artifacts, snapshot: newer, excludedTenants: [] }),
    false,
  );
});

test("parses only unique tenant exclusion scopes", () => {
  assert.deepEqual(parseExcludedTenants("tenant:2, tenant:8"), [
    "tenant:2",
    "tenant:8",
  ]);
  assert.throws(() => parseExcludedTenants("tenant:0"));
  assert.deepEqual(parseExcludedTenants("tenant:2,tenant:2"), ["tenant:2"]);
  assert.throws(() => parseExcludedTenants("private-name"));
});

test("uses one fixed read-only Cloudflare D1 request and appends current only for proven equality", async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const outputs: string[] = [];
  const env = {
    SAVIA_DEPLOY_ENVIRONMENT: "preview",
    CLOUDFLARE_ACCOUNT_ID: "account",
    CLOUDFLARE_API_TOKEN: "token",
    CLOUDFLARE_DATABASE_ID: "database",
    SAVIA_PREVIEW_STORE_EXCLUDED_TENANTS: "tenant:2",
    GITHUB_OUTPUT: "/tmp/github-output",
  };
  const result = await verifyPreviewStore({
    env,
    artifacts,
    fetch: async (url, init) => {
      requests.push({ url: String(url), init: init ?? {} });
      return Response.json({
        success: true,
        result: [
          {
            success: true,
            results: [
              {
                tenants: JSON.stringify(["tenant:1"]),
                catalog: JSON.stringify(
                  snapshot().catalog.filter(
                    (row) => row.tenant_id === "tenant:1",
                  ),
                ),
                installations: JSON.stringify(
                  snapshot().installations.filter(
                    (row) => row.tenant_id === "tenant:1",
                  ),
                ),
                objects: JSON.stringify(
                  snapshot().objects.filter(
                    (row) => row.tenant_id === "tenant:1",
                  ),
                ),
              },
            ],
          },
        ],
      });
    },
    appendOutput: (value) => outputs.push(value),
    log: () => undefined,
  });
  assert.equal(result, true);
  assert.equal(requests.length, 1);
  const body = JSON.parse(String(requests[0].init.body));
  assert.match(body.sql, /^\s*WITH\b/i);
  assert.match(body.sql, /\bSELECT\b/i);
  assert.doesNotMatch(
    body.sql,
    /\b(?:INSERT|UPDATE|DELETE|DROP|ALTER|CREATE)\b/i,
  );
  assert.equal(body.params[0], JSON.stringify(["tenant:2"]));
  assert.deepEqual(outputs, ["current=true"]);
});

test("stale, malformed and failed snapshots never append current=true", async () => {
  let calls = 0;
  for (const response of [
    Response.json({ success: false, result: [] }),
    Response.json({
      success: true,
      result: [{ success: true, results: [{ tenants: "not-json" }] }],
    }),
    new Response("unavailable", { status: 503 }),
  ]) {
    const outputs: string[] = [];
    const result = await verifyPreviewStore({
      env: {
        SAVIA_DEPLOY_ENVIRONMENT: "preview",
        CLOUDFLARE_ACCOUNT_ID: "account",
        CLOUDFLARE_API_TOKEN: "token",
        CLOUDFLARE_DATABASE_ID: "database",
        SAVIA_PREVIEW_STORE_EXCLUDED_TENANTS: "",
        GITHUB_OUTPUT: "/tmp/github-output",
      },
      artifacts,
      fetch: async () => {
        calls += 1;
        return response;
      },
      appendOutput: (value) => outputs.push(value),
      log: () => undefined,
    });
    assert.equal(result, false);
    assert.deepEqual(outputs, ["current=false"]);
  }
  assert.equal(calls, 3);
});
