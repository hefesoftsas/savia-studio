import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { symmetricEncrypt } from "better-auth/crypto";
import { createApiShell } from "../../api/src/api-shell";
import { createAuthHandler, createBetterAuth } from "../src/index";

it("completes the original OAuth login after an incorrect code and valid TOTP", async () => {
  const origin = "http://127.0.0.1:8787";
  const auth = createAuthHandler(env);
  const clientResponse = await auth.fetch(
    new Request(origin + "/_internal/oauth/admin-client"),
  );
  expect(clientResponse.status).toBe(200);
  const client = (await clientResponse.json()) as {
    clientId: string;
    redirectUri: string;
    resource: string;
    scopes: string[];
  };
  const betterAuth = createBetterAuth(env);
  const context = await betterAuth.$context;
  const user = await context.adapter.findOne<{ id: string }>({
    model: "user",
    where: [{ field: "email", value: env.BETTER_AUTH_BOOTSTRAP_EMAIL }],
  });
  expect(user).toBeTruthy();
  const secret = "oauth-mfa-continuation-secret";
  await context.adapter.update({
    model: "user",
    where: [{ field: "id", value: user!.id }],
    update: { twoFactorEnabled: true },
  });
  await context.adapter.create({
    model: "twoFactor",
    data: {
      userId: user!.id,
      secret: await symmetricEncrypt({
        key: env.BETTER_AUTH_SECRET,
        data: secret,
      }),
      backupCodes: await symmetricEncrypt({
        key: env.BETTER_AUTH_SECRET,
        data: "[]",
      }),
      verified: true,
    },
  });

  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode("v".repeat(64)),
  );
  const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  const authorization = new URL(origin + "/api/auth/oauth2/authorize");
  const state = "mfa-continuation.bookings?tab=reservations&date=2026-11-25";
  authorization.search = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: client.redirectUri,
    resource: client.resource,
    scope: client.scopes.join(" "),
    response_type: "code",
    prompt: "login",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  const start = await auth.fetch(new Request(authorization));
  expect(start.status).toBe(302);
  const login = new URL(start.headers.get("location")!, origin);
  expect(login.pathname).toBe("/api/auth/login");
  const loginPage = await auth.fetch(new Request(login));
  expect(await loginPage.text()).toContain(
    'data-oauth-restart-url="http://127.0.0.1:5173/#/login?resume=bookings&amp;tab=reservations&amp;date=2026-11-25"',
  );
  const oauthQuery = login.search.slice(1);
  const api = createApiShell(env.AUTH_DB, undefined, auth);
  const post = (path: string, body: unknown, cookie = "") =>
    api.request(origin + "/api/auth/" + path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        origin,
        cookie,
      },
      body: JSON.stringify(body),
    });
  const signIn = await post("sign-in/email", {
    email: env.BETTER_AUTH_BOOTSTRAP_EMAIL,
    password: env.BETTER_AUTH_BOOTSTRAP_PASSWORD,
    oauth_query: oauthQuery,
  });
  expect(await signIn.json()).toMatchObject({ twoFactorRedirect: true });
  const cookies = (response: Response) =>
    response.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
  const attemptTime = Date.now();
  const clock = vi.spyOn(Date, "now");
  const codeAt = async (offset: number) => {
    clock.mockReturnValue(attemptTime + offset);
    return (await betterAuth.api.generateTOTP({ body: { secret } })).code;
  };
  const challengeCookies = cookies(signIn);
  let verified: Response;
  try {
    const previous = await codeAt(-30_000);
    const next = await codeAt(30_000);
    const code = await codeAt(0);
    const invalidCode = ["000000", "111111", "222222", "333333"].find(
      (candidate) => ![previous, code, next].includes(candidate),
    )!;
    const rejected = await post(
      "two-factor/verify-totp",
      { code: invalidCode, oauth_query: oauthQuery },
      challengeCookies,
    );
    expect(rejected.status).toBe(401);
    expect(await rejected.json()).toMatchObject({ code: "INVALID_CODE" });
    verified = await post(
      "two-factor/verify-totp",
      { code, oauth_query: oauthQuery },
      challengeCookies,
    );
  } finally {
    clock.mockRestore();
  }
  expect(verified.status).toBe(200);
  const result = (await verified.json()) as { url?: string };
  // The OAuth hook normally returns the callback on the session-creating request.
  // A stripped query falls back to continuation and previously reopened login.
  const continuation = result.url
    ? result
    : ((await (
        await post(
          "oauth2/continue",
          { postLogin: true, oauth_query: oauthQuery },
          cookies(verified),
        )
      ).json()) as { url: string });
  expect(continuation.url).toBeTruthy();
  const destination = new URL(continuation.url!, origin);
  expect(destination.origin + destination.pathname).toBe(client.redirectUri);
  expect(destination.searchParams.get("code")).toBeTruthy();
  expect(destination.searchParams.get("state")).toBe(state);
});
