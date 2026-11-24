// Only known independent publications overlap. Auth initialization is a
// barrier; Request needs Hook Executor, Connectors needs Request, and the
// API and public gateway are published after their providers.
const dependencies = {
  auth: [],
  "auth-init": ["auth"],
  mcp: ["auth-init"],
  hookExecutor: ["auth-init"],
  pluginEditor: ["auth-init"],
  "editor-verify": ["pluginEditor"],
  flows: ["auth-init", "hookExecutor"],
  request: ["auth-init", "hookExecutor"],
  connectors: ["auth-init", "request"],
  api: [
    "auth-init",
    "mcp",
    "hookExecutor",
    "flows",
    "request",
    "connectors",
    "editor-verify",
  ],
  gateway: ["api", "editor-verify"],
};
const workers = new Set(
  Object.keys(dependencies).filter((name) => !name.includes("-")),
);

export async function runWorkerBatches(steps, execute, environment) {
  const concurrency = environment === "preview" ? 2 : 1;
  for (let offset = 0; offset < steps.length; offset += concurrency) {
    // Settle the whole batch before stopping on a failure.
    const results = await Promise.allSettled(
      steps
        .slice(offset, offset + concurrency)
        .map(async (step) => execute(step)),
    );
    const failure = results.find((result) => result.status === "rejected");
    if (failure) throw failure.reason;
  }
}

function identity(step) {
  if (
    step.kind === "wrangler" &&
    step.args?.[0] === "deploy" &&
    workers.has(step.worker)
  )
    return step.worker;
  if (
    step.kind === "node" &&
    step.script === "scripts/initialize-auth-deployment.mjs"
  )
    return "auth-init";
  if (step.kind === "plugin-editor-verify") return "editor-verify";
}

export async function runStandardDeploy(steps, execute, environment) {
  const ids = steps.map(identity);
  if (
    environment !== "preview" ||
    ids.includes(undefined) ||
    new Set(ids).size !== ids.length
  ) {
    for (const step of steps) await execute(step);
    return;
  }
  const byId = new Map(steps.map((step, index) => [ids[index], step]));
  const pending = new Set(
    Object.keys(dependencies).filter((id) => byId.has(id)),
  );
  const running = new Map();
  const complete = new Set();
  let failure;

  while (pending.size || running.size) {
    for (const id of pending) {
      if (failure || running.size === 2) break;
      if (
        dependencies[id].some(
          (parent) => byId.has(parent) && !complete.has(parent),
        )
      )
        continue;
      pending.delete(id);
      running.set(
        id,
        Promise.resolve()
          .then(() => execute(byId.get(id)))
          .then(
            () => complete.add(id),
            (reason) => {
              failure ??= { reason };
            },
          )
          .finally(() => running.delete(id)),
      );
    }
    if (failure) {
      await Promise.all(running.values());
      throw failure.reason;
    }
    if (!running.size)
      throw new Error("Preview Worker dependencies could not be resolved");
    await Promise.race(running.values());
  }
  if (failure) throw failure.reason;
}
