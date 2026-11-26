import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrapRuntimeWorkers } from "./runtime-bootstrap.mjs";
import { createRuntimeCloudClient } from "./runtime-cloud.mjs";

test("cold bootstrap publishes private unavailable placeholders only for new identities", async () => {
  const directory = await mkdtemp(join(tmpdir(), "savia-bootstrap-test-"));
  try {
    const workers = [
      { name: "savia-preview", cloudId: "b".repeat(32) },
      { name: "savia-auth-preview", cloudId: "c".repeat(32) },
    ];
    const calls = [];
    const client = {
      api: async (path) => {
        if (path.includes(workers[0].cloudId))
          return { ...workers[0], id: workers[0].cloudId, deployed_on: null };
        if (path.includes(workers[1].cloudId))
          return {
            ...workers[1],
            id: workers[1].cloudId,
            deployed_on: "2026-10-19T12:00:00Z",
          };
        return { bindings: [] };
      },
    };
    const result = await bootstrapRuntimeWorkers(
      { workers },
      { client, directory, runWrangler: async (args) => calls.push(args) },
    );
    assert.deepEqual(result.createdWorkers, ["savia-preview"]);
    assert.equal(calls.length, 1);
    const config = JSON.parse(await readFile(calls[0][2], "utf8"));
    assert.equal(config.workers_dev, false);
    assert.equal(config.preview_urls, false);
    assert.equal(config.vars.SAVIA_RUNTIME_BOOTSTRAP, "true");
    assert.doesNotMatch(
      await readFile(join(directory, "bootstrap.mjs"), "utf8"),
      /migrations|storage|namespace/,
    );
    const retryDirectory = join(directory, "retry");
    await mkdir(retryDirectory);
    client.api = async (path) => {
      const worker = workers.find((row) => path.includes(row.cloudId));
      if (worker)
        return {
          ...worker,
          id: worker.cloudId,
          deployed_on: "2026-10-19T12:00:00Z",
        };
      return {
        bindings: path.includes(workers[0].name)
          ? [
              {
                type: "plain_text",
                name: "SAVIA_RUNTIME_BOOTSTRAP",
                text: "true",
              },
            ]
          : [],
      };
    };
    const retried = await bootstrapRuntimeWorkers(
      { workers },
      {
        client,
        directory: retryDirectory,
        runWrangler: async (args) => calls.push(args),
      },
    );
    assert.deepEqual(retried.createdWorkers, [workers[0].name]);
    assert.equal(calls.length, 1);
    assert.equal(
      JSON.parse(
        await readFile(
          join(retryDirectory, `${workers[0].name}.bootstrap.json`),
          "utf8",
        ),
      ).name,
      workers[0].name,
    );
    client.api = async () => ({
      name: "other",
      id: workers[0].cloudId,
      deployed_on: null,
    });
    await assert.rejects(
      bootstrapRuntimeWorkers(
        { workers },
        { client, directory, runWrangler: async () => calls.push("mutation") },
      ),
      /identity/,
    );
    assert.equal(calls.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("application bootstrap uses serving versions without repeating healthy Worker reads", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "savia-bootstrap-serving-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const accountId = "a".repeat(32);
  const workers = [
    { name: "savia-preview", cloudId: "b".repeat(32) },
    { name: "savia-auth-preview", cloudId: "c".repeat(32) },
    { name: "savia-agencies-preview", cloudId: "d".repeat(32) },
  ];
  const servingFlags = ["", "SAVIA_RUNTIME_BOOTSTRAP", "SAVIA_RUNTIME_WARMUP"];
  const latestFlags = ["SAVIA_RUNTIME_BOOTSTRAP", "", ""];
  const reads = [];
  const bindingsFor = (name) =>
    name ? [{ name, type: "plain_text", text: "true" }] : [];
  const client = createRuntimeCloudClient(
    { accountId, workers },
    {
      env: { CLOUDFLARE_API_TOKEN: "test" },
      fetcher: async (url) => {
        const path = new URL(url).pathname.split(accountId)[1];
        reads.push(path);
        const index = workers.findIndex(
          ({ name, cloudId }) => path.includes(name) || path.endsWith(cloudId),
        );
        let result = [];
        if (index !== -1 && path.startsWith("/workers/workers/")) {
          const { cloudId, name } = workers[index];
          result = { id: cloudId, name, deployed_on: "2026-11-26T15:00:00Z" };
        } else if (path.endsWith("/deployments")) {
          result = {
            deployments: [
              { versions: [{ version_id: "serving", percentage: 100 }] },
            ],
          };
        } else if (path.endsWith("/versions/serving")) {
          result = {
            resources: { bindings: bindingsFor(servingFlags[index]) },
          };
        } else if (path.endsWith("/settings")) {
          result = { bindings: bindingsFor(latestFlags[index]) };
        }
        return Response.json({ success: true, result });
      },
    },
  );

  const snapshot = await client.readSnapshot({ includeBootstrapState: true });
  const result = await bootstrapRuntimeWorkers(
    { workers },
    {
      client,
      directory,
      observedWorkerVersions: snapshot.workerVersions,
      runWrangler: async () =>
        assert.fail("deployed Workers must not be replaced"),
    },
  );

  assert.deepEqual(result.createdWorkers, [workers[1].name]);
  assert.deepEqual(
    snapshot.workerVersions
      .filter((worker) => worker.retained)
      .map(({ name }) => name),
    [workers[2].name],
  );
  assert.equal(
    reads.filter((path) => path.startsWith("/workers/workers/")).length,
    workers.length,
  );
  assert.equal(
    reads.some((path) => path.endsWith("/settings")),
    false,
  );
});

test("application bootstrap refuses to replace a Worker deployed since observation", async () => {
  const worker = { name: "savia-preview", cloudId: "b".repeat(32) };
  await assert.rejects(
    bootstrapRuntimeWorkers(
      { workers: [worker] },
      {
        client: {
          api: async (path) => {
            if (path.endsWith("/settings")) return { bindings: [] };
            return {
              id: worker.cloudId,
              name: worker.name,
              deployed_on: "2026-11-26T15:00:00Z",
            };
          },
        },
        observedWorkerVersions: [{ ...worker, versionId: null }],
        runWrangler: async () =>
          assert.fail("concurrent deployment must be kept"),
      },
    ),
    /publication state changed/,
  );
});
