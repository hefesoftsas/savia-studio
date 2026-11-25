import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const script = fileURLToPath(
  new URL("./verify-better-auth-api.mjs", import.meta.url),
);

async function verifyMfaChallenge(prefix) {
  const received = [];
  const server = createServer((request, response) => {
    received.push([
      request.url,
      request.headers.cookie,
      request.headers.authorization,
    ]);
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/auth/sign-in/email") {
      response.setHeader("set-cookie", [
        `${prefix}savia.session_token=; Max-Age=0; Path=/`,
        `${prefix}savia.two_factor=challenge; Path=/; HttpOnly`,
      ]);
      response.end(JSON.stringify({ twoFactorRedirect: true }));
    } else if (request.url === "/api/auth/two-factor/verify-totp") {
      response.setHeader(
        "set-cookie",
        `${prefix}savia.session_token=session; Path=/; HttpOnly`,
      );
      response.setHeader("set-auth-token", "opaque");
      response.end("{}");
    } else {
      response.statusCode = request.headers.authorization ? 401 : 200;
      response.end("{}");
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const { stdout } = await run(process.execPath, [script], {
      env: {
        ...process.env,
        API_URL: `http://127.0.0.1:${server.address().port}`,
        TOTP_CODE: "123456",
      },
    });
    assert.match(
      stdout,
      /MFA-protected Better Auth-to-API cookie session verified/,
    );
    assert.ok(
      received.some(
        ([path, cookie]) =>
          path.endsWith("/verify-totp") &&
          cookie === `${prefix}savia.two_factor=challenge`,
      ),
    );
    assert.ok(
      received.some(
        ([path, cookie]) =>
          path === "/v1/identity/me" &&
          cookie === `${prefix}savia.session_token=session`,
      ),
    );
    assert.ok(
      received.some(
        ([path, , bearer]) =>
          path === "/v1/identity/me" && bearer === "Bearer opaque",
      ),
    );
  } finally {
    await promisify(server.close.bind(server))();
  }
}

test("the auth smoke check follows Better Auth's local MFA challenge cookie", () =>
  verifyMfaChallenge(""));

test("the auth smoke check forwards the actual secure cookie names", () =>
  verifyMfaChallenge("__Secure-"));
