import { describe, expect, it } from "vitest";
import {
  McpRequestCredentialError,
  readDelegatedRequestCredentials,
} from "../src/request-credentials";

describe("delegated MCP request credentials", () => {
  it("accepts the internal secret and the current user's bearer token", () => {
    expect(
      readDelegatedRequestCredentials(
        new Headers({
          "x-savia-mcp-secret": "internal-secret",
          "x-savia-user-authorization": "Bearer user-session-token",
        }),
        "internal-secret",
      ),
    ).toEqual({ authorization: "Bearer user-session-token" });
  });

  it.each([
    new Headers({ "x-savia-user-authorization": "Bearer user-session-token" }),
    new Headers({ "x-savia-mcp-secret": "wrong-secret" }),
    new Headers({ "x-savia-mcp-secret": "internal-secret" }),
    new Headers({
      "x-savia-mcp-secret": "internal-secret",
      "x-savia-user-authorization": "user-session-token",
    }),
  ])("rejects missing or invalid credentials", (headers) => {
    expect(() =>
      readDelegatedRequestCredentials(headers, "internal-secret"),
    ).toThrow(McpRequestCredentialError);
  });

  it.each([
    ["0", 0],
    ["15", 15],
    ["9007199254740991", Number.MAX_SAFE_INTEGER],
  ])("accepts trusted decimal tenant ID %s", (header, tenantId) => {
    expect(
      readDelegatedRequestCredentials(
        new Headers({
          "x-savia-mcp-secret": "internal-secret",
          "x-savia-user-authorization": "Bearer user-session-token",
          "x-savia-mcp-tenant-id": header,
        }),
        "internal-secret",
      ),
    ).toEqual({
      authorization: "Bearer user-session-token",
      studioTenantId: tenantId,
    });
  });

  it.each(["", "-1", "+1", "1.5", "1e2", "9007199254740992"])(
    "rejects malformed tenant ID %j",
    (tenantId) => {
      expect(() =>
        readDelegatedRequestCredentials(
          new Headers({
            "x-savia-mcp-secret": "internal-secret",
            "x-savia-user-authorization": "Bearer user-session-token",
            "x-savia-mcp-tenant-id": tenantId,
          }),
          "internal-secret",
        ),
      ).toThrow(McpRequestCredentialError);
    },
  );
});
