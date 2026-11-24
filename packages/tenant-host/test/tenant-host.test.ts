import { describe, expect, it } from "vitest";

import {
  buildTenantHostname,
  buildTenantOrigin,
  cookieDomainForHost,
  DEFAULT_CANONICAL_HOST,
  isAllowedPublicOrigin,
  isAllowedTenantOrigin,
  isCanonicalOrigin,
  isReservedTenantSlug,
  normalizeTenantSlug,
  parseTenantSlugFromHostname,
  tenantSlugFromName,
} from "../src/tenant-host";

describe("tenant-host", () => {
  it("derives a DNS-safe tenant slug from a name", () => {
    expect(tenantSlugFromName("  Asociación Ñandú & Hijos  ")).toBe(
      "asociacion-nandu-hijos",
    );
    expect(tenantSlugFromName("---")).toBe("tenant");
  });

  it("bounds generated slugs and avoids reserved names", () => {
    expect(tenantSlugFromName("admin")).toBe("admin-team");
    expect(tenantSlugFromName("x".repeat(70))).toBe("x".repeat(63));
    expect(tenantSlugFromName("a".repeat(62) + "!b")).toBe("a".repeat(62));
  });

  it("parses the Slack-style tenant subdomain", () => {
    expect(
      parseTenantSlugFromHostname(
        "example-organization.savia.hefesoft.com",
        DEFAULT_CANONICAL_HOST,
      ),
    ).toBe("example-organization");
  });

  it("is case-insensitive and ignores a trailing dot", () => {
    expect(
      parseTenantSlugFromHostname(
        "Example-Organization.SAVIA.HEFESOFT.COM.",
        DEFAULT_CANONICAL_HOST,
      ),
    ).toBe("example-organization");
  });

  it("returns null for the canonical host and unrelated hosts", () => {
    expect(
      parseTenantSlugFromHostname("savia.hefesoft.com", DEFAULT_CANONICAL_HOST),
    ).toBeNull();
    expect(
      parseTenantSlugFromHostname("evil.example.com", DEFAULT_CANONICAL_HOST),
    ).toBeNull();
    expect(
      parseTenantSlugFromHostname("127.0.0.1", DEFAULT_CANONICAL_HOST),
    ).toBeNull();
  });

  it("rejects nested subdomains and reserved slugs", () => {
    expect(
      parseTenantSlugFromHostname(
        "a.example-organization.savia.hefesoft.com",
        DEFAULT_CANONICAL_HOST,
      ),
    ).toBeNull();
    expect(parseTenantSlugFromHostname("api.savia.hefesoft.com")).toBeNull();
    expect(parseTenantSlugFromHostname("admin.savia.hefesoft.com")).toBeNull();
    expect(isReservedTenantSlug("API")).toBe(true);
    expect(isReservedTenantSlug("example-organization")).toBe(false);
  });

  it("rejects slugs that are not valid DNS labels", () => {
    expect(normalizeTenantSlug("sample_company")).toBeNull();
    expect(normalizeTenantSlug("-example")).toBeNull();
    expect(normalizeTenantSlug("example-")).toBeNull();
    expect(normalizeTenantSlug("")).toBeNull();
    expect(normalizeTenantSlug("a".repeat(64))).toBeNull();
    expect(normalizeTenantSlug(" example-123 ")).toBe("example-123");
  });

  it("builds tenant hostnames and origins", () => {
    expect(buildTenantHostname("example-organization")).toBe(
      "example-organization.savia.hefesoft.com",
    );
    expect(buildTenantOrigin("example-organization")).toBe(
      "https://example-organization.savia.hefesoft.com",
    );
  });

  it("allowlists only https tenant origins under the canonical host", () => {
    expect(
      isAllowedTenantOrigin("https://example-organization.savia.hefesoft.com"),
    ).toBe(true);
    expect(isAllowedTenantOrigin("https://savia.hefesoft.com")).toBe(false);
    expect(
      isAllowedTenantOrigin("http://example-organization.savia.hefesoft.com"),
    ).toBe(false);
    expect(isAllowedTenantOrigin("https://api.savia.hefesoft.com")).toBe(false);
    expect(isAllowedTenantOrigin("https://evil.com")).toBe(false);
    expect(isAllowedTenantOrigin("not-a-url")).toBe(false);
  });

  it("recognizes the canonical origin and the combined allowlist", () => {
    expect(isCanonicalOrigin("https://savia.hefesoft.com")).toBe(true);
    expect(isCanonicalOrigin("https://example-organization.savia.hefesoft.com")).toBe(
      false,
    );
    expect(isAllowedPublicOrigin("https://savia.hefesoft.com")).toBe(true);
    expect(
      isAllowedPublicOrigin("https://example-organization.savia.hefesoft.com"),
    ).toBe(true);
    expect(isAllowedPublicOrigin("https://evil.com")).toBe(false);
  });

  it("computes the shared cookie domain for subdomains and canonical host", () => {
    expect(
      cookieDomainForHost(
        "example-organization.savia.hefesoft.com",
        DEFAULT_CANONICAL_HOST,
      ),
    ).toBe(".savia.hefesoft.com");
    expect(
      cookieDomainForHost("savia.hefesoft.com", DEFAULT_CANONICAL_HOST),
    ).toBe(".savia.hefesoft.com");
    expect(
      cookieDomainForHost("localhost", DEFAULT_CANONICAL_HOST),
    ).toBeUndefined();
    expect(
      cookieDomainForHost("127.0.0.1", DEFAULT_CANONICAL_HOST),
    ).toBeUndefined();
    expect(
      cookieDomainForHost("evil.example.com", DEFAULT_CANONICAL_HOST),
    ).toBeUndefined();
  });

  it("supports preview canonical host and subdomains automatically", () => {
    expect(
      parseTenantSlugFromHostname("example-organization.savia-preview.hefesoft.com"),
    ).toBe("example-organization");
    expect(
      isAllowedTenantOrigin("https://example-organization.savia-preview.hefesoft.com"),
    ).toBe(true);
    expect(isCanonicalOrigin("https://savia-preview.hefesoft.com")).toBe(true);
    expect(
      isAllowedPublicOrigin("https://example-organization.savia-preview.hefesoft.com"),
    ).toBe(true);
    expect(cookieDomainForHost("example-organization.savia-preview.hefesoft.com")).toBe(
      ".savia-preview.hefesoft.com",
    );
    expect(cookieDomainForHost("savia-preview.hefesoft.com")).toBe(
      ".savia-preview.hefesoft.com",
    );
  });
});
