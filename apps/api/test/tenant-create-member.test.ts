import { createTestApp } from "./test-app";
import { env } from "cloudflare:workers";
import { beforeAll, expect, it, vi } from "vitest";
import { platformAdministratorAuthenticator } from "./auth-fixtures";
import {
  betterAuthUserAdministrator,
  type IdentityUserAdministrator,
} from "../src/auth/better-auth";
import {
  ensureBootstrapAdministrator,
  findPrincipalBySubject,
  grantMembership,
  setPrincipalActive,
  upsertPrincipal,
} from "../src/auth/identity-repository";
const migrations = Object.entries(
  import.meta.glob<string>("../../../packages/db/migrations/*.sql", {
    eager: true,
    import: "default",
    query: "?raw",
  }),
)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([, s]) => s);
beforeAll(async () => {
  for (const sql of migrations)
    for (const statement of sql
      .split("--> statement-breakpoint")
      .map((s) =>
        s
          .replace(/^--.*$/gm, "")
          .replace(/\s+/g, " ")
          .trim(),
      )
      .filter(Boolean))
      await env.DB.exec(statement);
});
let counter = 980000;

it.each(["fixture", "x".repeat(129)])(
  "returns a field-specific error for an invalid temporary password",
  async (temporaryPassword) => {
    const createUser = vi.fn();
    const app = createTestApp({
      auth: platformAdministratorAuthenticator(),
      userAdministrator: {
        issuer: "savia:better-auth",
        createUser,
      } as unknown as IdentityUserAdministrator,
    });
    const response = await app.request(
      "/v1/tenants",
      post({
        name: "Invalid password fixture",
        initialUser: {
          email: "password-validation@example.test",
          firstName: "Demo",
          lastName: "Admin",
          role: "tenant_admin",
          emailVerified: true,
          temporaryPassword,
        },
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "TENANT_TEMPORARY_PASSWORD_INVALID",
        message: "The temporary password must contain 12 to 128 characters.",
      },
    });
    expect(createUser).not.toHaveBeenCalled();
  },
);

it("binds a new tenant account to its email settings and sends a password setup link", async () => {
  const subject = "mail-initial-" + crypto.randomUUID();
  const createUser = vi.fn().mockResolvedValue({ subject });
  const sendPasswordReset = vi.fn().mockResolvedValue(undefined);
  const userAdministrator = {
    issuer: "savia:better-auth",
    createUser,
    sendPasswordReset,
    deleteUser: vi.fn(),
  } as unknown as IdentityUserAdministrator;
  const response = await createTestApp({
    auth: platformAdministratorAuthenticator(),
    userAdministrator,
  }).request(
    "/v1/tenants",
    post({
      name: "Email setup fixture",
      idSlug: "email-setup-fixture",
      initialUser: {
        email: "initial-email@example.test",
        firstName: "Initial",
        lastName: "User",
        role: "tenant_admin",
        emailVerified: true,
      },
    }),
  );
  expect(response.status).toBe(201);
  const body = (await response.json()) as { data: { id: number } };
  expect(createUser).toHaveBeenCalledWith(
    expect.objectContaining({
      tenantId: Number(body.data.id),
      emailVerified: true,
    }),
    expect.any(Request),
  );
  expect(sendPasswordReset).toHaveBeenCalledWith(subject, expect.any(Request));
});

it("rolls back tenant provisioning when Auth cannot deliver the password setup email", async () => {
  const subject = "failed-password-setup-" + crypto.randomUUID();
  const email = "failed-password-setup@example.test";
  const fetch = vi.fn(async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (request.method === "POST" && path === "/_internal/users")
      return Response.json({
        user: {
          id: subject,
          email,
          name: "Setup Admin",
          role: "user",
          isBanned: false,
          twoFactorEnabled: false,
        },
      });
    if (
      request.method === "POST" &&
      path === `/_internal/users/${subject}/password-reset`
    )
      return Response.json(
        { error: { code: "PASSWORD_RESET_EMAIL_UNAVAILABLE" } },
        { status: 503 },
      );
    if (request.method === "DELETE" && path === `/_internal/users/${subject}`)
      return new Response(null, { status: 204 });
    throw new Error("Unexpected Auth request");
  });
  const userAdministrator = betterAuthUserAdministrator(
    { fetch },
    "trusted-key",
  )!;
  const response = await createTestApp({
    auth: platformAdministratorAuthenticator(),
    userAdministrator,
  }).request(
    "/v1/tenants",
    post({
      name: "Failed password setup",
      initialUser: {
        email,
        firstName: "Setup",
        lastName: "Admin",
        role: "tenant_admin",
        emailVerified: true,
      },
    }),
  );
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({
    error: {
      code: "PASSWORD_RESET_EMAIL_UNAVAILABLE",
      message: "Password reset email delivery is unavailable",
    },
  });
  expect(fetch.mock.calls.map(([request]) => request.method)).toEqual([
    "POST",
    "POST",
    "DELETE",
  ]);
  expect(await tenantByName("Failed password setup")).toBeNull();
  expect(
    await findPrincipalBySubject(env.DB, userAdministrator.issuer, subject),
  ).toBeUndefined();
});

it("returns an email conflict and rolls back tenant creation when Auth rejects a duplicate", async () => {
  const source = await tenant("Existing identity tenant");
  const existing = await member(
    "duplicate-email@example.test",
    source.id,
    "viewer",
  );
  const administrator = betterAuthUserAdministrator(
    {
      async fetch() {
        return Response.json(
          {
            error: {
              code: "IDENTITY_EMAIL_CONFLICT",
              message:
                "An account with this email already exists. Use an existing user or a different email.",
            },
          },
          { status: 409 },
        );
      },
    },
    "trusted-key",
  );
  if (!administrator) throw new Error("Expected Better Auth administrator");

  const response = await createTestApp({
    auth: platformAdministratorAuthenticator(),
    userAdministrator: administrator,
  }).request(
    "/v1/tenants",
    post({
      name: "Duplicate email tenant",
      initialUser: {
        email: existing.email,
        firstName: "Duplicate",
        lastName: "Email",
        role: "tenant_admin",
        temporaryPassword: "Test-Fixture-Password-123!",
        emailVerified: true,
      },
    }),
  );

  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({
    error: {
      code: "IDENTITY_EMAIL_CONFLICT",
      message:
        "An account with this email already exists. Use an existing user or a different email.",
    },
  });
  expect(await tenantByName("Duplicate email tenant")).toBeNull();
  expect(await membershipOf(existing.id)).toEqual({
    tenant_id: source.id,
    role: "viewer",
  });
});

it("removes the newly provisioned Auth account even when tenant cleanup fails", async () => {
  const subject = "failed-tenant-cleanup-" + crypto.randomUUID();
  const deleteUser = vi.fn().mockResolvedValue(undefined);
  const sendPasswordReset = vi
    .fn()
    .mockRejectedValue(new Error("Delivery failed"));
  const userAdministrator = {
    issuer: "savia:better-auth",
    createUser: vi.fn().mockResolvedValue({ subject }),
    sendPasswordReset,
    deleteUser,
  } as unknown as IdentityUserAdministrator;
  await env.DB.exec(
    "CREATE TRIGGER fail_provisional_tenant_delete BEFORE DELETE ON tenants " +
      "WHEN OLD.id_slug = 'failed-provisional-cleanup' " +
      "BEGIN SELECT RAISE(ABORT, 'Tenant cleanup failed'); END;",
  );
  try {
    const response = await createTestApp({
      auth: platformAdministratorAuthenticator(),
      userAdministrator,
    }).request(
      "/v1/tenants",
      post({
        name: "Failed provisional cleanup",
        idSlug: "failed-provisional-cleanup",
        initialUser: {
          email: "failed-cleanup@example.test",
          firstName: "Test",
          lastName: "Admin",
          role: "tenant_admin",
          emailVerified: true,
        },
      }),
    );
    expect(response.status).toBe(500);
    expect(sendPasswordReset).toHaveBeenCalledWith(
      subject,
      expect.any(Request),
    );
    expect(await tenantByName("Failed provisional cleanup")).not.toBeNull();
    expect(deleteUser).toHaveBeenCalledWith(subject, expect.any(Request));
  } finally {
    await env.DB.exec("DROP TRIGGER fail_provisional_tenant_delete");
    await env.DB.prepare("DELETE FROM tenants WHERE id_slug=?")
      .bind("failed-provisional-cleanup")
      .run();
  }
});

it("keeps unknown Auth conflicts as service unavailable", async () => {
  const administrator = betterAuthUserAdministrator(
    {
      async fetch() {
        return Response.json(
          { error: { code: "AUTH_CONFIGURATION_CONFLICT" } },
          { status: 409 },
        );
      },
    },
    "trusted-key",
  );
  if (!administrator) throw new Error("Expected Better Auth administrator");

  const response = await createTestApp({
    auth: platformAdministratorAuthenticator(),
    userAdministrator: administrator,
  }).request(
    "/v1/tenants",
    post({
      name: "Unknown Auth conflict tenant",
      initialUser: {
        email: "unknown-conflict@example.test",
        firstName: "Unknown",
        lastName: "Conflict",
        role: "tenant_admin",
        temporaryPassword: "Test-Fixture-Password-123!",
        emailVerified: true,
      },
    }),
  );

  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({
    error: {
      code: "AUTHENTICATION_UNAVAILABLE",
      message: "Authentication service is unavailable",
    },
  });
  expect(await tenantByName("Unknown Auth conflict tenant")).toBeNull();
});
async function tenant(name = "Source agency") {
  // Wide spacing: tenant creation allocates MAX(id)+2, so sequential IDs
  // would collide with tenants created by the API under test.
  counter += 1000;
  const id = counter,
    slug = "transfer-" + id,
    now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO tenants(id,id_slug,name,is_active,created_at,updated_at,kind) VALUES(?,?,?,1,?,?,'commercial')",
  )
    .bind(id, slug, name, now, now)
    .run();
  return { id, slug };
}
async function member(
  email: string,
  tenantId: number,
  role: "tenant_admin" | "operator" | "viewer" = "operator",
) {
  const principal = await upsertPrincipal(env.DB, {
    issuer: "savia:better-auth",
    subject: email,
    email,
    displayName: email,
  });
  await grantMembership(env.DB, principal.id, tenantId, role);
  return principal;
}
function app() {
  // No user administrator on purpose: transferring an existing member must
  // not depend on the Better Auth service.
  return createTestApp({ auth: platformAdministratorAuthenticator() });
}
const post = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
async function tenantByName(name: string) {
  return env.DB.prepare("SELECT id FROM tenants WHERE name=?")
    .bind(name)
    .first<{ id: number }>();
}
async function membershipOf(principalId: string) {
  return env.DB.prepare(
    "SELECT tenant_id,role FROM identity_tenant_membership WHERE principal_id=?",
  )
    .bind(principalId)
    .first<{ tenant_id: number; role: string }>();
}
it("updates the email tenant when transferring an existing account", async () => {
  const source = await tenant();
  await member("smtp-stays@example.test", source.id, "tenant_admin");
  const moving = await member("smtp-moves@example.test", source.id);
  const updateUser = vi.fn().mockResolvedValue({});
  const userAdministrator = {
    issuer: "savia:better-auth",
    updateUser,
  } as unknown as IdentityUserAdministrator;
  const response = await createTestApp({
    auth: platformAdministratorAuthenticator(),
    userAdministrator,
  }).request(
    "/v1/tenants",
    post({
      name: "SMTP transfer",
      existingMember: { principalId: moving.id, role: "tenant_admin" },
    }),
  );
  expect(response.status).toBe(201);
  const body = (await response.json()) as { data: { id: number } };
  expect(updateUser).toHaveBeenCalledWith(
    moving.subject,
    { tenantId: Number(body.data.id) },
    expect.any(Request),
  );
});

it.each(["tenant creation", "membership assignment", "user update"])(
  "keeps Auth and membership aligned when another %s targets the first administrator",
  async (operation) => {
    const source = await tenant();
    const destination = await tenant();
    const suffix = source.id;
    await member(
      `concurrent-transfer-staying-${suffix}@example.test`,
      source.id,
    );
    const moving = await member(
      `concurrent-transfer-moving-${suffix}@example.test`,
      source.id,
    );
    const started = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    let authTenantId: number | null = source.id;
    const updateUser = vi.fn(
      async (_subject: string, input: { tenantId: number | null }) => {
        authTenantId = input.tenantId;
        if (updateUser.mock.calls.length === 1) {
          started.resolve();
          await resume.promise;
        }
        return {};
      },
    );
    const app = createTestApp({
      auth: platformAdministratorAuthenticator(),
      userAdministrator: {
        issuer: "savia:better-auth",
        updateUser,
      } as unknown as IdentityUserAdministrator,
    });
    const firstName = `Concurrent first transfer ${suffix}`;
    const secondName = `Concurrent rejected transfer ${suffix}`;
    const transfer = (name: string) =>
      app.request(
        "/v1/tenants",
        post({
          name,
          existingMember: { principalId: moving.id, role: "tenant_admin" },
        }),
      );

    const first = transfer(firstName);
    let second: Response;
    try {
      await started.promise;
      const user = `/v1/identity/users/${moving.id}`;
      const membership = { tenantId: destination.id, role: "tenant_admin" };
      if (operation === "tenant creation") second = await transfer(secondName);
      else if (operation === "membership assignment")
        second = await app.request(`${user}/memberships`, post(membership));
      else
        second = await app.request(user, {
          ...post({ membership }),
          method: "PATCH",
        });
    } finally {
      resume.resolve();
    }
    expect((await first).status).toBe(201);
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({
      error: { code: "IDENTITY_ACCESS_CHANGE_IN_PROGRESS" },
    });
    const saved = await membershipOf(moving.id);
    expect(authTenantId).toBe(saved?.tenant_id);
    expect((await tenantByName(firstName))?.id).toBe(saved?.tenant_id);
    expect(await tenantByName(secondName)).toBeNull();
    expect(updateUser).toHaveBeenCalledOnce();
    expect(
      await env.DB.prepare(
        "SELECT 1 FROM identity_access_change_leases WHERE principal_id=?",
      )
        .bind(moving.id)
        .first(),
    ).toBeNull();
  },
);

it("creates an inactive tenant with its new first administrator", async () => {
  const subject = "inactive-tenant-admin-" + crypto.randomUUID();
  const email = "inactive-tenant-admin@example.test";
  const userAdministrator = {
    issuer: "savia:better-auth",
    createUser: vi.fn().mockResolvedValue({ subject }),
    deleteUser: vi.fn(),
    sendPasswordReset: vi.fn(),
  } as unknown as IdentityUserAdministrator;
  const response = await createTestApp({
    auth: platformAdministratorAuthenticator(),
    userAdministrator,
  }).request(
    "/v1/tenants",
    post({
      name: "Inactive tenant with new administrator",
      isActive: false,
      initialUser: {
        email,
        firstName: "Inactive",
        lastName: "Administrator",
        role: "tenant_admin",
        temporaryPassword: "Test-Fixture-Password-123!",
        emailVerified: true,
      },
    }),
  );
  expect(response.status).toBe(201);
  const { data } = (await response.json()) as {
    data: { id: number; isActive: boolean };
  };
  expect(data.isActive).toBe(false);
  const principal = await findPrincipalBySubject(
    env.DB,
    userAdministrator.issuer,
    subject,
  );
  expect(await membershipOf(principal!.id)).toEqual({
    tenant_id: data.id,
    role: "tenant_admin",
  });
  expect(userAdministrator.sendPasswordReset).not.toHaveBeenCalled();
});
it("creates an inactive tenant by transferring an existing administrator", async () => {
  const source = await tenant();
  const staying = await member(
    "inactive-destination-stays@example.test",
    source.id,
    "tenant_admin",
  );
  const moving = await member(
    "inactive-destination-moves@example.test",
    source.id,
  );
  const response = await app().request(
    "/v1/tenants",
    post({
      name: "Inactive tenant with transferred administrator",
      isActive: false,
      existingMember: { principalId: moving.id, role: "tenant_admin" },
    }),
  );
  expect(response.status).toBe(201);
  const { data } = (await response.json()) as {
    data: { id: number; isActive: boolean };
  };
  expect(data.isActive).toBe(false);
  expect(await membershipOf(moving.id)).toEqual({
    tenant_id: data.id,
    role: "tenant_admin",
  });
  expect(await membershipOf(staying.id)).toMatchObject({
    tenant_id: source.id,
  });
  await expect(
    grantMembership(env.DB, staying.id, data.id, "viewer"),
  ).rejects.toMatchObject({ code: "COMMERCIAL_TENANT_REQUIRED" });
});

it.each(["new", "existing"] as const)(
  "keeps an inactive tenant while provisioning its %s administrator",
  async (mode) => {
    const issuer = "savia:better-auth";
    const subject = `provisioning-${mode}-${crypto.randomUUID()}`;
    const email = `${subject}@example.test`;
    const name = `Concurrent provisioning ${mode}`;
    const managedUser = {
      subject,
      email,
      displayName: name,
      role: "user" as const,
      isBanned: false,
      twoFactorEnabled: false,
    };
    const existing =
      mode === "existing"
        ? await upsertPrincipal(env.DB, {
            issuer,
            subject,
            email,
            displayName: name,
          })
        : undefined;
    let deletion: Response | undefined;
    const removeTenant = async (tenantId: number | null | undefined) => {
      if (typeof tenantId !== "number") return;
      const url = `/v1/tenants/${tenantId}`;
      deletion = await instance.request(
        mode === "existing"
          ? `${url}?cascade=true&confirmation=${encodeURIComponent(name)}`
          : url,
        { method: "DELETE" },
      );
    };
    const purge = vi.fn(async () => Response.json({ purged: {} }));
    const sendPasswordReset = vi.fn();
    const instance = createTestApp({
      auth: platformAdministratorAuthenticator(),
      documents: env.DOCUMENTS,
      saviaRequestService: { fetch: purge },
      userAdministrator: {
        issuer,
        createUser: async ({ tenantId }) => {
          await removeTenant(tenantId);
          return managedUser;
        },
        updateUser: async (_subject, { tenantId }) => {
          await removeTenant(tenantId);
          return managedUser;
        },
        sendPasswordReset,
        deleteUser: vi.fn().mockResolvedValue(undefined),
      } as IdentityUserAdministrator,
    });

    const response = await instance.request(
      "/v1/tenants",
      post({
        name,
        isActive: false,
        ...(existing
          ? {
              existingMember: {
                principalId: existing.id,
                role: "tenant_admin",
              },
            }
          : {
              initialUser: {
                email,
                firstName: "Provisioned",
                lastName: "Admin",
                role: "tenant_admin",
                temporaryPassword: "Test-Fixture-Password-123!",
              },
            }),
      }),
    );

    expect(deletion?.status).toBe(409);
    expect(await deletion?.json()).toMatchObject({
      error: { code: "TENANT_PURGE_IN_PROGRESS" },
    });
    expect(response.status, await response.clone().text()).toBe(201);
    const { data } = (await response.json()) as { data: { id: number } };
    const principal = await findPrincipalBySubject(env.DB, issuer, subject);
    expect(await membershipOf(principal!.id)).toEqual({
      tenant_id: data.id,
      role: "tenant_admin",
    });
    expect(purge).not.toHaveBeenCalled();
    expect(sendPasswordReset).not.toHaveBeenCalled();
    expect(
      await env.DB.prepare(
        "SELECT 1 FROM tenant_deletion_leases WHERE tenant_id=?",
      )
        .bind(data.id)
        .first(),
    ).toBeNull();
  },
);

it("restores the email scope when transfer eligibility changes during provisioning", async () => {
  const source = await tenant();
  const staying = await member("smtp-staying-member@example.test", source.id);
  const moving = await member(
    "smtp-final-member@example.test",
    source.id,
    "tenant_admin",
  );
  const updateUser = vi
    .fn()
    .mockImplementationOnce(async () => {
      await setPrincipalActive(env.DB, staying.id, false);
      return {};
    })
    .mockResolvedValueOnce({});
  const userAdministrator = {
    issuer: "savia:better-auth",
    updateUser,
  } as unknown as IdentityUserAdministrator;
  const response = await createTestApp({
    auth: platformAdministratorAuthenticator(),
    userAdministrator,
  }).request(
    "/v1/tenants",
    post({
      name: "Rejected SMTP transfer",
      existingMember: { principalId: moving.id, role: "tenant_admin" },
    }),
  );
  expect(response.status).toBe(409);
  expect(updateUser).toHaveBeenCalledTimes(2);
  expect(updateUser).toHaveBeenLastCalledWith(
    moving.subject,
    { tenantId: source.id },
    expect.any(Request),
  );
  expect(await membershipOf(moving.id)).toMatchObject({ tenant_id: source.id });
  expect(await tenantByName("Rejected SMTP transfer")).toBeNull();
});
it("removes the provisional tenant even if restoring the Auth scope fails", async () => {
  const source = await tenant();
  const staying = await member("smtp-rollback-staying@example.test", source.id);
  const moving = await member(
    "smtp-rollback-failure@example.test",
    source.id,
    "tenant_admin",
  );
  const updateUser = vi
    .fn()
    .mockImplementationOnce(async () => {
      await setPrincipalActive(env.DB, staying.id, false);
      return {};
    })
    .mockRejectedValueOnce(new Error("Auth unavailable during rollback"));
  const userAdministrator = {
    issuer: "savia:better-auth",
    updateUser,
  } as unknown as IdentityUserAdministrator;
  const response = await createTestApp({
    auth: platformAdministratorAuthenticator(),
    userAdministrator,
  }).request(
    "/v1/tenants",
    post({
      name: "Failed SMTP rollback",
      idSlug: "failed-smtp-rollback",
      existingMember: { principalId: moving.id, role: "tenant_admin" },
    }),
  );
  expect(response.status).toBe(500);
  expect(updateUser).toHaveBeenCalledTimes(2);
  expect(updateUser).toHaveBeenLastCalledWith(
    moving.subject,
    { tenantId: source.id },
    expect.any(Request),
  );
  expect(await membershipOf(moving.id)).toMatchObject({ tenant_id: source.id });
  expect(await tenantByName("Failed SMTP rollback")).toBeNull();
  expect(
    await env.DB.prepare("SELECT slug FROM tenant_slug_aliases WHERE slug=?")
      .bind("failed-smtp-rollback")
      .first(),
  ).toBeNull();
});
it("transfers an existing user as first member and keeps the source tenant", async () => {
  const source = await tenant(),
    staying = await member("stays@example.test", source.id, "tenant_admin"),
    moving = await member("moves@example.test", source.id, "operator");
  const response = await app().request(
    "/v1/tenants",
    post({
      name: "Destination agency",
      existingMember: { principalId: moving.id, role: "tenant_admin" },
    }),
  );
  expect(response.status).toBe(201);
  const created = ((await response.json()) as any).data;
  expect(created.name).toBe("Destination agency");
  expect(await membershipOf(moving.id)).toEqual({
    tenant_id: created.id,
    role: "tenant_admin",
  });
  expect(await membershipOf(staying.id)).toEqual({
    tenant_id: source.id,
    role: "tenant_admin",
  });
});
it("rejects unknown or inactive principals without creating a tenant", async () => {
  const unknown = await app().request(
    "/v1/tenants",
    post({
      name: "Nowhere agency",
      existingMember: { principalId: crypto.randomUUID(), role: "viewer" },
    }),
  );
  expect(unknown.status).toBe(404);
  expect(await unknown.json()).toEqual({
    error: { code: "USER_NOT_FOUND", message: "El usuario no existe." },
  });
  const ghost = await upsertPrincipal(env.DB, {
    issuer: "savia:better-auth",
    subject: "ghost@example.test",
    email: "ghost@example.test",
    displayName: "Ghost",
  });
  await setPrincipalActive(env.DB, ghost.id, false);
  const inactive = await app().request(
    "/v1/tenants",
    post({
      name: "Ghost agency",
      existingMember: { principalId: ghost.id, role: "viewer" },
    }),
  );
  expect(inactive.status).toBe(404);
  expect(await tenantByName("Nowhere agency")).toBe(null);
  expect(await tenantByName("Ghost agency")).toBe(null);
});
it("rejects platform administrators without touching tenants", async () => {
  const source = await tenant();
  await member("admin-source@example.test", source.id, "tenant_admin");
  const principal = await upsertPrincipal(env.DB, {
    issuer: "savia:better-auth",
    subject: "super@example.test",
    email: "super@example.test",
    displayName: "Super",
  });
  await ensureBootstrapAdministrator(env.DB, principal.id);
  const response = await app().request(
    "/v1/tenants",
    post({
      name: "Super agency",
      existingMember: { principalId: principal.id, role: "tenant_admin" },
    }),
  );
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({
    error: { code: "TENANT_CONFLICT", reason: "PLATFORM_ADMIN" },
  });
  expect(await tenantByName("Super agency")).toBe(null);
  expect(await membershipOf(principal.id)).toEqual({
    tenant_id: 0,
    role: "tenant_admin",
  });
});
it("rejects transferring the last active member before allocating a tenant or updating Auth", async () => {
  const source = await tenant(),
    only = await member("only@example.test", source.id, "tenant_admin");
  const updateUser = vi.fn().mockResolvedValue({});
  const userAdministrator = {
    issuer: "savia:better-auth",
    updateUser,
  } as unknown as IdentityUserAdministrator;
  const tenantSequence = () =>
    env.DB.prepare(
      "SELECT next_id FROM server_id_sequences WHERE resource='tenants'",
    ).first();
  const previousSequence = await tenantSequence();
  const response = await createTestApp({
    auth: platformAdministratorAuthenticator(),
    userAdministrator,
  }).request(
    "/v1/tenants",
    post({
      name: "Lonely agency",
      existingMember: { principalId: only.id, role: "tenant_admin" },
    }),
  );
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({
    error: { code: "TENANT_CONFLICT", reason: "LAST_ACTIVE_MEMBER" },
  });
  expect(await tenantByName("Lonely agency")).toBe(null);
  expect(updateUser).not.toHaveBeenCalled();
  expect(await tenantSequence()).toEqual(previousSequence);
  expect(await membershipOf(only.id)).toEqual({
    tenant_id: source.id,
    role: "tenant_admin",
  });
});
it("requires exactly one member source", async () => {
  const source = await tenant(),
    person = await member("either@example.test", source.id);
  const neither = await app().request(
    "/v1/tenants",
    post({ name: "Neither agency" }),
  );
  expect(neither.status).toBe(400);
  const both = await app().request(
    "/v1/tenants",
    post({
      name: "Both agency",
      initialUser: {
        email: "new@example.test",
        firstName: "New",
        lastName: "User",
        role: "tenant_admin",
      },
      existingMember: { principalId: person.id, role: "viewer" },
    }),
  );
  expect(both.status).toBe(400);
  expect(await tenantByName("Neither agency")).toBe(null);
  expect(await tenantByName("Both agency")).toBe(null);
});

it("assigns a readable slug, resolves collisions and keeps it stable on rename", async () => {
  const source = await tenant("Slug source");
  await member("slug-staying@example.test", source.id, "tenant_admin");
  const first = await member("slug-first@example.test", source.id);
  const second = await member("slug-second@example.test", source.id);
  const create = (principalId: string) =>
    app().request(
      "/v1/tenants",
      post({
        name: "Águila & Compañía",
        existingMember: { principalId, role: "tenant_admin" },
      }),
    );
  const firstResponse = await create(first.id);
  expect(firstResponse.status).toBe(201);
  const a = ((await firstResponse.json()) as any).data;
  expect(a.idSlug).toBe("aguila-compania");
  const secondResponse = await create(second.id);
  expect(secondResponse.status).toBe(201);
  expect(((await secondResponse.json()) as any).data.idSlug).toBe(
    "aguila-compania-2",
  );
  const renamed = await app().request(`/v1/tenants/${a.id}`, {
    ...post({ name: "New business name" }),
    method: "PATCH",
  });
  expect(renamed.status).toBe(200);
  expect(((await renamed.json()) as any).data.idSlug).toBe("aguila-compania");
});

it("keeps old tenant slugs reserved and resolves them after a controlled URL change", async () => {
  const source = await tenant("Legacy slug source");
  const response = await app().request(`/v1/tenants/${source.id}`, {
    ...post({ idSlug: "friendly-legacy-source" }),
    method: "PATCH",
  });
  expect(response.status).toBe(200);
  const current = await app().request(
    `https://${source.slug}.savia-preview.hefesoft.com/v1/tenants/current`,
  );
  expect(current.status).toBe(200);
  expect(((await current.json()) as any).data.slug).toBe(
    "friendly-legacy-source",
  );
  const other = await tenant("Other slug source");
  const conflict = await app().request(`/v1/tenants/${other.id}`, {
    ...post({ idSlug: source.slug }),
    method: "PATCH",
  });
  expect(conflict.status).toBe(409);
});

it("reserves different readable URLs for simultaneous tenant creations", async () => {
  const source = await tenant("Concurrent source");
  await member("parallel-staying@example.test", source.id, "tenant_admin");
  const first = await member("parallel-one@example.test", source.id);
  const second = await member("parallel-two@example.test", source.id);
  const responses = await Promise.all(
    [first, second].map((principal) =>
      app().request(
        "/v1/tenants",
        post({
          name: "Concurrent Team",
          existingMember: { principalId: principal.id, role: "tenant_admin" },
        }),
      ),
    ),
  );
  expect(responses.map((r) => r.status)).toEqual([201, 201]);
  const slugs = await Promise.all(
    responses.map(
      async (response) => ((await response.json()) as any).data.idSlug,
    ),
  );
  expect(slugs.sort()).toEqual(["concurrent-team", "concurrent-team-2"]);
});

it("does not restore a stale URL when a name-only edit races with a URL migration", async () => {
  const source = await tenant("Concurrent rename source");
  let release!: () => void;
  let captured!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const read = new Promise<void>((resolve) => {
    captured = resolve;
  });
  const prepare = env.DB.prepare.bind(env.DB);
  let intercept = true;
  const spy = vi.spyOn(env.DB, "prepare").mockImplementation((sql) => {
    const statement = prepare(sql);
    if (intercept && sql.includes("WHERE t.id=? AND t.kind='commercial'")) {
      intercept = false;
      return {
        bind: (...args: unknown[]) => ({
          first: async () => {
            const row = await statement.bind(...args).first();
            captured();
            await blocked;
            return row;
          },
        }),
      } as unknown as D1PreparedStatement;
    }
    return statement;
  });
  try {
    const nameUpdate = app().request(`/v1/tenants/${source.id}`, {
      ...post({ name: "Renamed concurrently" }),
      method: "PATCH",
    });
    await read;
    const urlUpdate = await app().request(`/v1/tenants/${source.id}`, {
      ...post({ idSlug: "stable-concurrent-url" }),
      method: "PATCH",
    });
    expect(urlUpdate.status).toBe(200);
    release();
    expect((await nameUpdate).status).toBe(200);
    const row = await prepare("SELECT id_slug AS slug FROM tenants WHERE id=?")
      .bind(source.id)
      .first<{ slug: string }>();
    expect(row?.slug).toBe("stable-concurrent-url");
  } finally {
    release();
    spy.mockRestore();
  }
});
