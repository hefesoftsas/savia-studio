import assert from "node:assert/strict";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const executeFile = promisify(execFile);

async function localDevelopmentCommands({
  mcpEnabled = true,
  adminPort = null,
  port5173Occupied = false,
  backendPortOccupied = false,
  flowsEnabled = true,
  failFlowsBuild = false,
  delayApiReady = false,
  delayPrivateWorkers = false,
  apiExitAfterAdminStarts = null,
  competingStart = false,
  interruptPreparation = false,
  devHost = "127.0.0.1",
  inheritedOpenRouterKey = "",
  hasOpenRouterKeyFile = true,
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), "savia-dev-local-"));
  const output = join(directory, "commands.txt");
  const secrets = join(directory, "secrets");
  const pnpm = join(directory, "pnpm");
  const curl = join(directory, "curl");
  const lsof = join(directory, "lsof");
  await mkdir(secrets);
  await writeFile(
    join(secrets, "assistant-api.dev.env"),
    (hasOpenRouterKeyFile ? "OPENROUTER_API_KEY=openrouter-test-key\n" : "") +
      "ASSISTANT_SETTINGS_ENCRYPTION_KEY=base64-test-key\nOPENROUTER_MODEL=test-model\nNANGO_BASE_URL=https://nango.test\nNANGO_CONNECT_URL=https://connect.nango.test\nNANGO_API_KEY=nango-test-key\nNANGO_HUBSPOT_INTEGRATION_ID=hubspot\nNANGO_GOOGLE_DRIVE_INTEGRATION_ID=google-drive\nNANGO_GMAIL_INTEGRATION_ID=gmail\nNANGO_GOOGLE_CALENDAR_INTEGRATION_ID=google-calendar\nNANGO_OUTLOOK_INTEGRATION_ID=outlook\nNANGO_ONEDRIVE_PERSONAL_INTEGRATION_ID=onedrive-personal\nNANGO_ONEDRIVE_BUSINESS_INTEGRATION_ID=onedrive-business\nNANGO_JIRA_INTEGRATION_ID=jira\nNANGO_LINEAR_INTEGRATION_ID=linear\n",
  );
  await writeFile(
    join(secrets, "auth.dev.env"),
    "BETTER_AUTH_SECRET=auth-test-secret\n",
  );
  await writeFile(
    join(secrets, "connector-gateway.dev.env"),
    "EXTENSION_CONNECTIONS_ENCRYPTION_KEY=connector-gateway-test-key\n",
  );
  if (mcpEnabled) {
    await writeFile(
      join(secrets, "mcp.dev.env"),
      "SAVIA_MCP_SHARED_SECRET=test-mcp-secret\n",
    );
  }
  await writeFile(
    pnpm,
    `#!/bin/sh
case "$OPENROUTER_API_KEY" in
  "") openrouter_scope="" ;;
  openrouter-test-key) openrouter_scope="configured-key" ;;
  test-openrouter-override) openrouter_scope="caller-override" ;;
  *) openrouter_scope="unexpected-key" ;;
esac
printf '%s|%s|%s|%s|%s|%s|%s|auth-secret=%s\\n' "$MCP_TRANSPORT" "$MCP_HOST" "$SAVIA_API_URL" "$SAVIA_MCP_URL" "$openrouter_scope" "$SAVIA_MCP_SHARED_SECRET" "$*" "$BETTER_AUTH_SECRET" >> "$TMPDIR/commands.txt"
printf 'jira-reporting=%s\\n' "$NANGO_JIRA_REPORTING_CONNECTION_ID" >> "$TMPDIR/commands.txt"
printf 'bridge=%s|%s\\n' "$SAVIA_INTERNAL_BRIDGE_KEY" "$*" >> "$TMPDIR/commands.txt"
printf 'local-admin-api=%s|%s\\n' "$SAVIA_DEV_USE_LOCAL_API" "$*" >> "$TMPDIR/commands.txt"
printf 'local-origins=%s|%s|%s\\n' "$SAVIA_DEV_HOST" "$SAVIA_PUBLIC_ORIGIN" "$*" >> "$TMPDIR/commands.txt"
stay_running() {
  trap 'exit 0' TERM
  while :; do sleep 0.05; done
}
case "$*" in
  flows:build) exit ${failFlowsBuild ? 9 : 0} ;;
  *"build:downloads"*)
    if [ "${competingStart ? "1" : "0"}" = 1 ]; then
      if [ "$SAVIA_TEST_COMPETING_START" = 1 ]; then exit 12; fi
      echo preparation-started
      until [ -f "$TMPDIR/finish-preparation" ]; do sleep 0.02; done
    fi
    if [ "${interruptPreparation ? "1" : "0"}" = 1 ]; then
      echo preparation-started
      sleep 1
      echo preparation-finished >> "$TMPDIR/commands.txt"
    fi
    ;;
  *scripts/dev-api-runtime.mjs*)
    if [ "${apiExitAfterAdminStarts ?? ""}" = "" ]; then stay_running; fi
    until [ -f "$TMPDIR/admin-started" ]; do sleep 0.02; done
    exit ${apiExitAfterAdminStarts ?? 0}
    ;;
  *"@savia/admin exec vite"*)
    trap 'echo admin-stopped >> "$TMPDIR/commands.txt"; exit 0' TERM
    touch "$TMPDIR/admin-started"
    echo admin-started
    while :; do sleep 0.05; done
    ;;
  *"exec wrangler dev"*|*"@savia/mcp start"|flows:dev) stay_running ;;
esac
`,
  );
  await chmod(pnpm, 0o700);
  await writeFile(
    curl,
    `#!/bin/sh
printf 'curl|%s\\n' "$*" >> "$TMPDIR/commands.txt"
case "$*" in
  *":8797/api/health"*)
    if [ "${delayPrivateWorkers ? "1" : "0"}" = 1 ] && [ ! -f "$TMPDIR/request-probed" ]; then
      touch "$TMPDIR/request-probed"
      printf '%s\\n' '{"error":"Acceso privado."}' 503
    else
      printf '%s\\n' '{"error":"Acceso privado."}' 403
    fi
    ;;
  *":8798/execute"*)
    if [ "${delayPrivateWorkers ? "1" : "0"}" = 1 ] && [ ! -f "$TMPDIR/hooks-probed" ]; then
      touch "$TMPDIR/hooks-probed"
      printf '%s\\n' '<html>Not found</html>' 404
    else
      printf '%s\\n' 'Not found' 404
    fi
    ;;
  *":8787/health"*)
    if [ "${delayApiReady ? "1" : "0"}" = 1 ] && [ ! -f "$TMPDIR/api-probed" ]; then
      touch "$TMPDIR/api-probed"
      exit 22
    elif [ "${delayApiReady ? "1" : "0"}" = 1 ] && [ ! -f "$TMPDIR/api-maintenance" ]; then
      touch "$TMPDIR/api-maintenance"
      printf '%s\\n' '{"status":"maintenance"}'
    else
      printf '%s\\n' '{"status":"ok","database":"ok"}'
    fi
    ;;
esac
`,
  );
  await chmod(curl, 0o700);
  await writeFile(
    lsof,
    `#!/bin/sh
case "$*" in
  *TCP:5173*) exit ${port5173Occupied ? 0 : 1} ;;
  *TCP:8788*) exit ${backendPortOccupied ? 0 : 1} ;;
esac
exit 1
`,
  );
  await chmod(lsof, 0o700);

  const launch = (extraEnvironment = {}) =>
    executeFile("sh", ["scripts/dev-local.sh"], {
      timeout: 5000,
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        SAVIA_SECRETS_DIR: secrets,
        SAVIA_DEV_HOST: devHost,
        SAVIA_ADMIN_PORT: adminPort ?? "",
        SAVIA_FLOWS_ENABLED: flowsEnabled ? "1" : "0",
        NANGO_JIRA_REPORTING_CONNECTION_ID: "jira-owner-local",
        OPENROUTER_API_KEY: inheritedOpenRouterKey,
        TMPDIR: directory,
        ...extraEnvironment,
      },
    });
  const startup = launch();
  let stoppedByTest = false;
  if (apiExitAfterAdminStarts === null) {
    startup.child.stdout.on("data", (chunk) => {
      if (chunk.includes("admin-started")) {
        stoppedByTest = startup.child.kill("SIGTERM");
      }
    });
  }
  let duplicateFailure;
  if (competingStart) {
    try {
      const [ready] = await once(startup.child.stdout, "data", {
        signal: AbortSignal.timeout(3000),
      });
      assert.match(ready.toString(), /preparation-started/);
      await launch({ SAVIA_TEST_COMPETING_START: "1" });
    } catch (error) {
      duplicateFailure = error;
    } finally {
      await writeFile(join(directory, "finish-preparation"), "");
    }
  } else if (interruptPreparation) {
    const [ready] = await once(startup.child.stdout, "data", {
      signal: AbortSignal.timeout(3000),
    });
    assert.match(ready.toString(), /preparation-started/);
    stoppedByTest = startup.child.kill("SIGINT");
  }
  try {
    await startup;
  } catch (error) {
    if (!stoppedByTest || error.code !== (interruptPreparation ? 130 : 143)) {
      error.startedCommands = await readFile(output, "utf8").catch(() => "");
      throw error;
    }
  }
  if (competingStart) {
    assert.equal(duplicateFailure?.code, 1);
    assert.match(
      duplicateFailure.stderr,
      /A local Savia stack is already starting or running/,
    );
  }
  return readFile(output, "utf8");
}

test("rejects a second stack before it can start preparation", async () => {
  const commands = await localDevelopmentCommands({ competingStart: true });
  assert.equal(
    commands.match(/\|--filter @savia\/admin run build:downloads\|/g)?.length,
    1,
  );
});

test("interrupts an active preparation command when the user presses Ctrl+C", async () => {
  const commands = await localDevelopmentCommands({
    interruptPreparation: true,
  });
  assert.doesNotMatch(commands, /preparation-finished|migrations apply/);
});

test("finishes local preparation before starting the first service", async () => {
  const commands = await localDevelopmentCommands();
  const startAuth = commands.indexOf("--filter @savia/auth exec wrangler dev");
  assert.ok(startAuth >= 0);
  for (const preparation of [
    "--filter @savia/admin run build:downloads",
    "--filter @savia/api exec wrangler d1 migrations apply",
    "--filter @savia/request run setup:local",
    "--filter @savia/request run migrate:local",
    "flows:build",
  ]) {
    const position = commands.indexOf(preparation);
    assert.ok(position >= 0 && position < startAuth, preparation);
  }
});

test("does not start local services when the Flows build fails", async () => {
  await assert.rejects(
    localDevelopmentCommands({ failFlowsBuild: true }),
    (error) => {
      assert.equal(error.code, 9);
      assert.match(error.startedCommands, /flows:build/);
      assert.doesNotMatch(
        error.startedCommands,
        /wrangler dev|@savia\/mcp start/,
      );
      return true;
    },
  );
});

test("starts Admin with no Flows build or runtime when Flows is disabled", async () => {
  const commands = await localDevelopmentCommands({ flowsEnabled: false });
  assert.match(commands, /@savia\/admin exec vite/);
  assert.doesNotMatch(commands, /flows:(build|dev)|:8796\/health/);
});

test("starts the application locally with the private Savia request Worker", async () => {
  const commands = await localDevelopmentCommands({ adminPort: "5174" });

  assert.match(
    commands,
    /curl\|--fail --silent --max-time 2 http:\/\/127\.0\.0\.1:8788\/_internal\/session/,
  );
  assert.match(
    commands,
    /\|\|\|http:\/\/127\.0\.0\.1:8789\/mcp\|\|\|--filter @savia\/api exec wrangler d1 migrations apply savia-agencies --local --config wrangler\.jsonc/,
  );
  assert.match(
    commands,
    /\|\|\|http:\/\/127\.0\.0\.1:8789\/mcp\|\|\|--filter @savia\/auth exec wrangler dev --local --ip 127\.0\.0\.1 --port 8788 --inspector-port 9230 --config wrangler\.jsonc --var SAVIA_ADMIN_REDIRECT_URI:http:\/\/127\.0\.0\.1:5174\/auth\/callback/,
  );
  assert.match(commands, /--var BETTER_AUTH_SECRET:auth-test-secret/);
  assert.match(
    commands,
    /http\|127\.0\.0\.1\|http:\/\/127\.0\.0\.1:8787\|\|\|test-mcp-secret\|--filter @savia\/mcp start/,
  );
  assert.match(
    commands,
    /--filter @savia\/hook-executor exec wrangler dev --local --ip 127\.0\.0\.1 --port 8798 --inspector-port 9233 --config wrangler\.jsonc/,
  );
  assert.match(
    commands,
    /--filter @savia\/request exec wrangler dev --local --ip 127\.0\.0\.1 --port 8797 --inspector-port 9232 --config wrangler\.jsonc/,
  );
  assert.match(commands, /exec node scripts\/dev-api-runtime\.mjs/);
  assert.match(commands, /jira-reporting=jira-owner-local/);
  assert.doesNotMatch(commands, /crm-sync-local-scheduler/);
  assert.doesNotMatch(
    commands,
    /--filter @savia\/legacy-api exec wrangler dev/,
  );
  assert.doesNotMatch(commands, /--var NANGO_API_KEY/);
  assert.doesNotMatch(commands, /--var NANGO_JIRA_REPORTING_CONNECTION_ID/);
  assert.match(
    commands,
    /\|\|\|http:\/\/127\.0\.0\.1:8789\/mcp\|\|\|--filter @savia\/admin exec vite --host 127\.0\.0\.1 --port 5174 --strictPort/,
  );
  assert.match(
    commands,
    /^local-admin-api=true\|--filter @savia\/admin exec vite/m,
  );
});

for (const [source, hasOpenRouterKeyFile] of [
  ["configured-key", true],
  ["caller-override", false],
]) {
  test(`passes the ${source} OpenRouter credential only to the local API`, async () => {
    const commands = await localDevelopmentCommands({
      inheritedOpenRouterKey: "test-openrouter-override",
      hasOpenRouterKeyFile,
      flowsEnabled: false,
    });
    const recipients = commands
      .split("\n")
      .filter((line) =>
        /\|(?:caller-override|configured-key|unexpected-key)\|/.test(line),
      );
    assert.equal(recipients.length, 1);
    assert.ok(
      recipients[0].includes(
        `|${source}||exec node scripts/dev-api-runtime.mjs|`,
      ),
    );
  });
}

test("rejects a second local stack before building against an occupied Auth port", async () => {
  await assert.rejects(
    localDevelopmentCommands({ backendPortOccupied: true }),
    (error) => {
      assert.match(error.stderr, /port 8788 is already in use/i);
      assert.equal(error.startedCommands, "");
      return true;
    },
  );
});

for (const adminPort of ["0", "65536", "5187.5", "-1", "not-a-port"]) {
  test(`rejects invalid Admin port ${adminPort} before preparing the stack`, async () => {
    await assert.rejects(localDevelopmentCommands({ adminPort }), (error) => {
      assert.match(error.stderr, /SAVIA_ADMIN_PORT.*1.*65535/);
      assert.equal(error.startedCommands, "");
      return true;
    });
  });
}

test("rejects a padded reserved Admin port before preparing the stack", async () => {
  await assert.rejects(
    localDevelopmentCommands({ adminPort: "08787" }),
    (error) => {
      assert.match(error.stderr, /Admin port 8787 is reserved/);
      assert.equal(error.startedCommands, "");
      return true;
    },
  );
});

test("stops Admin and reports the API exit after startup", async () => {
  await assert.rejects(
    localDevelopmentCommands({ apiExitAfterAdminStarts: 7 }),
    (error) => {
      assert.equal(error.code, 7);
      assert.match(error.stderr, /Local Savia API exited with status 7/);
      assert.match(error.startedCommands, /admin-stopped/);
      return true;
    },
  );
});

test("stops Admin when the API exits unexpectedly with status zero", async () => {
  await assert.rejects(
    localDevelopmentCommands({ apiExitAfterAdminStarts: 0 }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(
        error.stderr,
        /Local Savia API exited unexpectedly with status 0/,
      );
      assert.match(error.startedCommands, /admin-stopped/);
      return true;
    },
  );
});

test("waits for the API to connect to D1 before starting Admin", async () => {
  const commands = await localDevelopmentCommands({ delayApiReady: true });
  const apiProbes = [
    ...commands.matchAll(
      /^curl\|--fail --silent --max-time 2 http:\/\/127\.0\.0\.1:8787\/health$/gm,
    ),
  ];
  assert.equal(apiProbes.length, 3);
  assert.ok(
    commands.indexOf("--filter @savia/admin exec vite") > apiProbes[2].index,
  );
});

test("waits for both private Workers before starting Admin", async () => {
  const commands = await localDevelopmentCommands({
    delayPrivateWorkers: true,
    flowsEnabled: false,
  });
  const admin = commands.indexOf("--filter @savia/admin exec vite");
  for (const url of [
    "http://127.0.0.1:8797/api/health",
    "http://127.0.0.1:8798/execute",
  ]) {
    const probes = commands
      .split("\n")
      .filter((line) => line.startsWith("curl|") && line.endsWith(url));
    assert.equal(probes.length, 2, `Expected ${url} to be checked again`);
    assert.ok(admin > commands.lastIndexOf(probes[1]));
  }
});

test("uses the next free Admin port for both Vite and OAuth", async () => {
  const commands = await localDevelopmentCommands({
    mcpEnabled: false,
    port5173Occupied: true,
  });

  assert.match(
    commands,
    /--config wrangler\.jsonc --var SAVIA_ADMIN_REDIRECT_URI:http:\/\/127\.0\.0\.1:5174\/auth\/callback/,
  );
  assert.match(
    commands,
    /--filter @savia\/admin exec vite --host 127\.0\.0\.1 --port 5174 --strictPort/,
  );
});

test("runs without MCP when its shared secret is absent", async () => {
  const commands = await localDevelopmentCommands({ mcpEnabled: false });

  assert.doesNotMatch(commands, /--filter @savia\/mcp dev/);
  assert.doesNotMatch(commands, /--var SAVIA_MCP_URL/);
  assert.doesNotMatch(commands, /--var SAVIA_MCP_SHARED_SECRET/);
});

test("shares an ephemeral Auth bridge key with the API without MCP", async () => {
  const commands = await localDevelopmentCommands({ mcpEnabled: false });
  const authKey = commands.match(
    /--var SAVIA_INTERNAL_BRIDGE_KEY:([a-f0-9]{64})/,
  )?.[1];
  assert.ok(authKey);
  assert.ok(
    commands.includes(
      `bridge=${authKey}|exec node scripts/dev-api-runtime.mjs`,
    ),
  );
});

test("exposes Admin inside a container while preserving browser OAuth URLs", async () => {
  const commands = await localDevelopmentCommands({
    devHost: "0.0.0.0",
    adminPort: "5173",
  });
  assert.match(commands, /vite --host 0\.0\.0\.0 --port 5173 --strictPort/);
  assert.match(
    commands,
    /SAVIA_ADMIN_REDIRECT_URI:http:\/\/127\.0\.0\.1:5173\/auth\/callback/,
  );
  assert.match(
    commands,
    /@savia\/auth exec wrangler dev --local --ip 127\.0\.0\.1/,
  );
});

test("uses localhost for Admin and OAuth while the API proxy stays on IPv4 loopback", async () => {
  const commands = await localDevelopmentCommands({
    devHost: "localhost",
    adminPort: "05187",
    flowsEnabled: false,
  });
  assert.match(commands, /vite --host localhost --port 5187 --strictPort/);
  assert.match(
    commands,
    /SAVIA_ADMIN_REDIRECT_URI:http:\/\/localhost:5187\/auth\/callback/,
  );
  assert.match(
    commands,
    /^local-origins=127\.0\.0\.1\|http:\/\/localhost:5187\|exec node scripts\/dev-api-runtime\.mjs$/m,
  );
});

test("can verify Admin forwarding and reject a successful HTML fallback", async (t) => {
  let adminServesShell = false;
  let interruptOpenApi = true;
  const server = createServer((request, response) => {
    const path = request.url.split("/").at(-1);
    if (request.url.startsWith("/admin/") && adminServesShell) {
      response.setHeader("content-type", "text/html");
      response.end("<html>Admin shell</html>");
      return;
    }
    if (path === "docs") {
      response.end("<html>Scalar API reference</html>");
      return;
    }
    if (path === "openapi.json" && interruptOpenApi) {
      interruptOpenApi = false;
      response.writeHead(200, { "content-length": 64, connection: "close" });
      response.end("{");
      return;
    }
    response.end(
      JSON.stringify(
        path === "health"
          ? { status: "ok", database: "ok" }
          : { openapi: "3.1.0", paths: { "/health": {} } },
      ),
    );
  });
  t.after(() => server[Symbol.asyncDispose]());
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  const verify = (adminUrl) =>
    executeFile("sh", ["scripts/verify-local-stack.sh"], {
      env: { ...process.env, API_URL: `${origin}/api`, ADMIN_URL: adminUrl },
      timeout: 5000,
    });
  assert.match((await verify("")).stdout, /Local stack verified/);
  assert.match(
    (await verify(`${origin}/admin`)).stdout,
    /Local Admin proxy verified/,
  );
  adminServesShell = true;
  await assert.rejects(verify(`${origin}/admin`), {
    code: 1,
    stderr: `Expected ${origin}/admin/health to report status: ok and database: ok\n`,
  });
});
