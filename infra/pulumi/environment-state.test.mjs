import test from "node:test";
import assert from "node:assert/strict";
import { normalizeCheckpoint, readStateCatalog } from "./environment-state.mjs";
import { stateBackendUrl } from "./naming.mjs";
const accountId = "a".repeat(32),
  backendUrl = stateBackendUrl(accountId, "savia-pulumi-state-preview");
test("checkpoint normalization exposes only physical identities and rejects account confusion", () => {
  const stateExport = {
    deployment: {
      resources: [
        {
          type: "cloudflare:index/worker:Worker",
          urn: "urn:pulumi:preview::savia-cloudflare::cloudflare:index/worker:Worker::runtime",
          id: "b".repeat(32),
          inputs: { accountId, name: "savia-preview" },
          outputs: {
            accountId,
            name: "savia-preview",
            secret: "SECRET_CANARY",
          },
        },
      ],
    },
  };
  const result = normalizeCheckpoint({
    qualifiedStack: "organization/savia-cloudflare/preview",
    backendUrl,
    stateExport,
    accountId,
  });
  assert.deepEqual(result.resources, [
    { kind: "worker", name: "savia-preview", cloudId: "b".repeat(32) },
  ]);
  assert.equal(
    JSON.stringify(result.resources).includes("SECRET_CANARY"),
    false,
  );
  const mixed = structuredClone(stateExport);
  mixed.deployment.resources[0].inputs.accountId = "c".repeat(32);
  assert.throws(
    () =>
      normalizeCheckpoint({
        qualifiedStack: "organization/savia-cloudflare/preview",
        backendUrl,
        stateExport: mixed,
        accountId,
      }),
    /account/i,
  );
});
test("every known backend must be readable and ambiguous duplicate stack locations fail", async () => {
  const options = {
    accountId,
    backends: [backendUrl],
    env: {},
    run: async (_bin, args) => ({
      stdout: JSON.stringify(
        args[0] === "stack" && args[1] === "ls"
          ? [{ name: "organization/savia-cloudflare/preview" }]
          : { deployment: { resources: [] } },
      ),
    }),
  };
  assert.equal((await readStateCatalog(options)).length, 1);
  await assert.rejects(
    readStateCatalog({
      ...options,
      backends: [backendUrl, backendUrl + "&other=1"],
    }),
    /backend/i,
  );
  await assert.rejects(
    readStateCatalog({
      ...options,
      run: async () => {
        throw new Error("denied");
      },
    }),
    /denied|read/i,
  );
});

test("Preview reads at most four independent checkpoints at a time in catalog order", async () => {
  const names = Array.from(
    { length: 6 },
    (_, index) => `organization/savia-cloudflare/preview-${index}`,
  );
  for (const [environment, expected] of [
    ["preview", 4],
    ["production", 1],
  ]) {
    let active = 0;
    let peak = 0;
    const checkpoints = await readStateCatalog({
      accountId,
      backends: [backendUrl],
      env: { SAVIA_DEPLOY_ENVIRONMENT: environment },
      run: async (_command, args) => {
        if (args[1] === "ls") {
          return { stdout: JSON.stringify(names.map((name) => ({ name }))) };
        }
        peak = Math.max(peak, ++active);
        await new Promise((resolve) => setImmediate(resolve));
        active--;
        return { stdout: JSON.stringify({ deployment: { resources: [] } }) };
      },
    });
    assert.equal(peak, expected);
    assert.deepEqual(
      checkpoints.map(({ qualifiedStack }) => qualifiedStack),
      names,
    );
  }
});

test("retained namespace custody remains attributed to its native host after release retirement", () => {
  const stateExport = {
    deployment: {
      resources: [
        {
          type: "pulumi:pulumi:Stack",
          outputs: {
            environmentInventory: {
              resources: [
                {
                  kind: "durableObject",
                  name: "savia-agencies-preview_RealtimeHub",
                  cloudId: "c".repeat(32),
                  parentWorker: "savia-agencies-preview",
                },
              ],
            },
          },
        },
        {
          type: "cloudflare:index/worker:Worker",
          id: "b".repeat(32),
          inputs: { accountId, name: "savia-agencies-preview" },
          outputs: { accountId, name: "savia-agencies-preview" },
        },
      ],
    },
  };
  const result = normalizeCheckpoint({
    qualifiedStack: "organization/savia-cloudflare/preview",
    backendUrl,
    stateExport,
    accountId,
  });
  assert.equal(
    result.resources.filter((row) => row.kind === "durableObject").length,
    1,
  );
});
