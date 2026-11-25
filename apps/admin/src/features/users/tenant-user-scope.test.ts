import { describe, expect, it } from "vitest";
import {
  tenantAdminTenantId,
  tenantAdminUserUpdateData,
  userCreateScope,
} from "./tenant-user-scope";

describe("tenant user administration scope", () => {
  it("resolves the tenant from an administrator membership", () => {
    expect(
      tenantAdminTenantId([
        { tenantId: 101, role: "agency_admin" },
        { tenantId: 202, role: "viewer" },
      ]),
    ).toBe(101);
  });

  it("does not derive a tenant from viewer, platform, invalid, or ambiguous memberships", () => {
    expect(tenantAdminTenantId([{ tenantId: 101, role: "viewer" }])).toBe(
      undefined,
    );
    expect(tenantAdminTenantId([{ tenantId: 0, role: "tenant_admin" }])).toBe(
      undefined,
    );
    expect(
      tenantAdminTenantId([
        { tenantId: 101, role: "tenant_admin" },
        { tenantId: 202, role: "agency_admin" },
      ]),
    ).toBe(undefined);
  });

  it("prefills tenant-admin user creation without granting platform access", () => {
    expect(
      userCreateScope({
        canReadDocuments: true,
        canExecuteCommands: true,
        canManageIdentity: false,
        memberships: [{ tenantId: 101, role: "tenant_admin" }],
      }),
    ).toEqual({
      platformCanEdit: false,
      tenantId: 101,
      defaultValues: {
        platformAdmin: false,
        agencyRole: "viewer",
        tenantId: 101,
      },
    });
  });

  it("strips platform and tenant scope from tenant-admin user updates", () => {
    const data = {
      firstName: "Ari",
      lastName: "Rios",
      platformAdmin: true,
      tenantId: 999,
      agencyId: 999,
      memberships: [{ tenantId: 999, role: "tenant_admin" }],
    };
    expect(tenantAdminUserUpdateData(data)).toEqual({
      firstName: "Ari",
      lastName: "Rios",
    });
  });

  it.each([
    { previous: true, value: true, expected: {} },
    { previous: false, value: false, expected: {} },
    { previous: undefined, value: false, expected: {} },
    { previous: true, value: false, expected: { emailVerified: false } },
    { previous: false, value: true, expected: { emailVerified: true } },
  ])(
    "updates email verification from $previous to $value only when changed",
    ({ previous, value, expected }) => {
      expect(
        tenantAdminUserUpdateData(
          { firstName: "Ari", lastName: "Rios", emailVerified: value },
          {
            previousData: {
              firstName: "Ari",
              lastName: "Rios",
              emailVerified: previous,
            },
          },
        ),
      ).toEqual(expected);
    },
  );

  it("omits a legacy empty surname when saving a new first name", () => {
    expect(
      tenantAdminUserUpdateData(
        { firstName: "Ariana", lastName: "" },
        { previousData: { firstName: "Ari", lastName: "" } },
      ),
    ).toEqual({ firstName: "Ariana" });
  });
});
