import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function bootstrapRuntimeWorkers(
  inputs,
  { client, directory, observedWorkerVersions, runWrangler },
) {
  const pending = [];
  const observedWorkers = observedWorkerVersions
    ? new Map(observedWorkerVersions.map((worker) => [worker.name, worker]))
    : null;
  // Verify every target before the first publication.
  for (const worker of inputs.workers) {
    if (
      typeof worker.name !== "string" ||
      !/^[a-z0-9][a-z0-9-]{1,62}$/.test(worker.name) ||
      !/^[a-f\d]{32}$/.test(worker.cloudId)
    )
      throw new Error("Invalid bootstrap identity");
    if (observedWorkers) {
      const observed = observedWorkers.get(worker.name);
      if (observed?.cloudId !== worker.cloudId)
        throw new Error("Bootstrap Worker identity mismatch");
      if (observed.versionId !== null) {
        if (typeof observed.versionId !== "string" || !observed.versionId)
          throw new Error("Unknown Worker publication state");
        if (observed.bootstrapPlaceholder === true)
          pending.push({ name: worker.name, publish: false });
        continue;
      }
    }
    // Recheck undeployed identities before creating a placeholder.
    const native = await client.api(`/workers/workers/${worker.cloudId}`);
    if (native.id !== worker.cloudId || native.name !== worker.name)
      throw new Error("Bootstrap Worker identity mismatch");
    if (native.deployed_on === null)
      pending.push({ name: worker.name, publish: true });
    else {
      if (typeof native.deployed_on !== "string")
        throw new Error("Unknown Worker publication state");
      if (observedWorkers)
        throw new Error("Worker publication state changed during bootstrap");
      const settings = await client.api(
        `/workers/scripts/${worker.name}/settings`,
      );
      if (
        settings.bindings?.some(
          (binding) =>
            binding.type === "plain_text" &&
            binding.name === "SAVIA_RUNTIME_BOOTSTRAP" &&
            binding.text === "true",
        )
      )
        pending.push({ name: worker.name, publish: false });
    }
  }
  if (pending.length) {
    await writeFile(
      join(directory, "bootstrap.mjs"),
      'export default { fetch() { return new Response("Environment unavailable", { status: 503 }); } };',
      { mode: 0o600 },
    );
    for (const worker of pending) {
      const config = join(directory, `${worker.name}.bootstrap.json`);
      await writeFile(
        config,
        JSON.stringify({
          name: worker.name,
          main: "bootstrap.mjs",
          compatibility_date: "2026-10-01",
          workers_dev: false,
          preview_urls: false,
          vars: { SAVIA_RUNTIME_BOOTSTRAP: "true" },
        }),
        { mode: 0o600 },
      );
      if (worker.publish)
        await runWrangler(["deploy", "--config", config], { cwd: directory });
    }
  }
  return { createdWorkers: pending.map((worker) => worker.name) };
}
