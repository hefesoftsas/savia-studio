import assert from "node:assert/strict";
import test from "node:test";

import * as setup from "./setup.mjs";
const { findDatabaseUuid, maskSecret, validatePublicOrigin } = setup;
import { DEMO_TENANT, extractSessionCookie } from "./seed-demo.mjs";

test("accepts https origins with real domains only", () => {
  assert.equal(
    validatePublicOrigin("https://demo.example.com/"),
    "https://demo.example.com",
  );
  for (const bad of [
    "http://demo.example.com",
    "https://localhost",
    "notaurl",
    "",
  ]) {
    assert.throws(() => validatePublicOrigin(bad), /HTTPS|domain|Invalid URL/);
  }
});

test("masks secrets for logs", () => {
  assert.equal(maskSecret("abcdefghij123"), "abc…23");
  assert.equal(maskSecret("short"), "****");
});

test("finds database uuids", () => {
  const rows = [
    { name: "savia-agencies", uuid: "11111111-2222-3333-4444-555555555555" },
  ];
  assert.equal(
    findDatabaseUuid(JSON.stringify(rows), "savia-agencies"),
    "11111111-2222-3333-4444-555555555555",
  );
  assert.equal(findDatabaseUuid("[]", "missing"), null);
  assert.equal(findDatabaseUuid("not-json", "missing"), null);
});

test("bootstrap uses only the adopted production infrastructure matching its plan", () => {
  assert.equal(typeof setup.validateSetupInfrastructure, "function");
  const outputs = {
    resolvedEnvironment: "production",
    resolvedPublicOrigin: "https://demo.example.com",
    documentsBucketName: "savia-documents",
    authD1Id: "auth-id",
    domainD1Id: "domain-id",
  };
  const plan = {
    publicOrigin: "https://demo.example.com",
    documentsBucket: "savia-documents",
  };
  assert.deepEqual(setup.validateSetupInfrastructure(outputs, plan), {
    auth: "auth-id",
    domain: "domain-id",
  });
  for (const bad of [
    { ...outputs, resolvedEnvironment: "preview" },
    { ...outputs, resolvedPublicOrigin: "https://other.example.com" },
    { ...outputs, documentsBucketName: "savia-documents-preview" },
    { ...outputs, authD1Id: "" },
  ])
    assert.throws(
      () => setup.validateSetupInfrastructure(bad, plan),
      /infrastructure|outputs/,
    );
});

test("extracts session cookies from set-cookie headers", () => {
  assert.equal(
    extractSessionCookie([
      "savia.session=a1b2; Path=/; HttpOnly",
      "other=x; Path=/",
    ]),
    "savia.session=a1b2; other=x",
  );
  assert.equal(
    extractSessionCookie("savia.session=a1b2; Path=/; HttpOnly"),
    "savia.session=a1b2",
  );
  assert.throws(() => extractSessionCookie([]), /no session cookie/);
});

test("demo tenant is fixed", () => {
  assert.equal(DEMO_TENANT.idSlug, "demo");
  assert.equal(DEMO_TENANT.name, "Agencia Demo");
});
