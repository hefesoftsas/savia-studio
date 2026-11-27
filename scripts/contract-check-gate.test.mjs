import assert from "node:assert/strict";
import test from "node:test";
import { evaluateContractGate } from "./contract-check-gate.mjs";

const needs = (ciKind, contractResult) => ({
  changes: {
    result: "success",
    outputs: { kind: "platform", ci_kind: ciKind },
  },
  "plugin-validation": { result: "skipped" },
  "runtime-profile": { result: "skipped" },
  "contract-suite":
    contractResult === undefined ? {} : { result: contractResult },
});

test("contract gate accepts ci-config only when classification and contracts succeeded", () => {
  assert.deepEqual(evaluateContractGate(needs("ci-config", "success")), []);

  for (const contractResult of ["failure", "cancelled", "skipped", undefined]) {
    assert.notDeepEqual(
      evaluateContractGate(needs("ci-config", contractResult)),
      [],
    );
  }

  const failedClassification = needs("ci-config");
  failedClassification.changes.result = "failure";
  assert.ok(evaluateContractGate(failedClassification).length > 0);
});

test("contract gate rejects unknown CI kinds", () => {
  const failures = evaluateContractGate(needs("ci-config-unknown"));
  assert.ok(
    failures.some((failure) =>
      failure.includes("CI kind was invalid: ci-config-unknown"),
    ),
  );
});

test("self-hosted contract gate requires its runtime profile and contracts", () => {
  const complete = needs("self-hosted", "success");
  complete["runtime-profile"] = { result: "success" };
  assert.deepEqual(evaluateContractGate(complete), []);

  for (const result of ["failure", "cancelled", "skipped", undefined]) {
    const incomplete = structuredClone(complete);
    if (result === undefined) delete incomplete["runtime-profile"];
    else incomplete["runtime-profile"].result = result;
    assert.ok(
      evaluateContractGate(incomplete).some((failure) =>
        failure.includes(`runtime profile result was ${result ?? "missing"}`),
      ),
      `runtime profile=${result ?? "missing"} must fail the gate`,
    );
  }

  for (const result of ["failure", "cancelled", "skipped", undefined]) {
    const incomplete = structuredClone(complete);
    if (result === undefined) delete incomplete["contract-suite"];
    else incomplete["contract-suite"].result = result;
    assert.ok(
      evaluateContractGate(incomplete).some((failure) =>
        failure.includes(`contract suite result was ${result ?? "missing"}`),
      ),
      `contract suite=${result ?? "missing"} must fail the gate`,
    );
  }
});

test("frontend contract gate requires runtime profile and every admin shard", () => {
  const complete = needs("frontend", "success");
  complete["runtime-profile"] = { result: "success" };
  for (const job of [
    "admin",
    "admin-2",
    "admin-3",
    "admin-4",
    "admin-5",
    "admin-6",
  ]) {
    complete[job] = { result: "success" };
  }
  assert.deepEqual(evaluateContractGate(complete), []);

  for (const [job, result] of [
    ["runtime-profile", "skipped"],
    ["admin", "failure"],
    ["admin-2", "skipped"],
    ["admin-3", "cancelled"],
    ["admin-4", undefined],
    ["admin-5", "failure"],
    ["admin-6", "skipped"],
  ]) {
    const incomplete = structuredClone(complete);
    if (result === undefined) delete incomplete[job];
    else incomplete[job].result = result;
    assert.ok(
      evaluateContractGate(incomplete).some((failure) =>
        failure.includes(
          `${job === "runtime-profile" ? "runtime profile" : job} result was ${result ?? "missing"}`,
        ),
      ),
      `${job}=${result ?? "missing"} must fail the gate`,
    );
  }
});

test("assistant API gate requires MCP, its profile, and all API test shards", () => {
  const complete = needs("assistant-api", "success");
  complete["runtime-profile"] = { result: "success" };
  complete["assistant-mcp"] = { result: "success" };
  complete["api-extra-shards"] = { result: "success" };
  complete.api = { result: "success" };
  complete["api-2"] = { result: "success" };
  complete["api-3"] = { result: "success" };
  assert.deepEqual(evaluateContractGate(complete), []);

  for (const [job, result] of [
    ["runtime-profile", "failure"],
    ["assistant-mcp", "skipped"],
    ["api-extra-shards", "failure"],
    ["api-extra-shards", "skipped"],
    ["api-extra-shards", undefined],
    ["api", "skipped"],
    ["api-2", "cancelled"],
    ["api-3", undefined],
  ]) {
    const incomplete = structuredClone(complete);
    if (result === undefined) delete incomplete[job];
    else incomplete[job].result = result;
    assert.ok(
      evaluateContractGate(incomplete).some((failure) =>
        failure.includes(
          `${job === "runtime-profile" ? "runtime profile" : job} result was ${result ?? "missing"}`,
        ),
      ),
      `${job}=${result ?? "missing"} must fail the gate`,
    );
  }
});

test("focused API gate requires all three protected API contexts and extra shards", () => {
  const complete = needs("api", "success");
  complete["runtime-profile"] = { result: "success" };
  complete["api-extra-shards"] = { result: "success" };
  complete.api = { result: "success" };
  complete["api-2"] = { result: "success" };
  complete["api-3"] = { result: "success" };
  assert.deepEqual(evaluateContractGate(complete), []);

  for (const job of ["api", "api-2", "api-3"]) {
    for (const result of ["failure", "cancelled", "skipped", undefined]) {
      const incomplete = structuredClone(complete);
      if (result === undefined) delete incomplete[job];
      else incomplete[job].result = result;
      assert.ok(
        evaluateContractGate(incomplete).some((failure) =>
          failure.includes(`${job} result was ${result ?? "missing"}`),
        ),
        `${job}=${result ?? "missing"} must fail the gate`,
      );
    }
  }

  for (const [job, result] of [
    ["api-extra-shards", "failure"],
    ["api-extra-shards", "skipped"],
    ["api-extra-shards", "missing"],
  ]) {
    const incomplete = structuredClone(complete);
    if (result === "missing") delete incomplete[job];
    else incomplete[job].result = result;
    assert.ok(
      evaluateContractGate(incomplete).some((failure) =>
        failure.includes(
          `${job} result was ${result === "missing" ? "missing" : result}`,
        ),
      ),
      `${job}=${result} must fail the gate`,
    );
  }
});

test("contract gate rejects frontend for a missing or unsuccessful admin shard", () => {
  const incomplete = needs("frontend", "success");
  incomplete["runtime-profile"] = { result: "success" };
  for (const job of ["admin", "admin-2", "admin-3", "admin-4", "admin-5"]) {
    incomplete[job] = { result: "success" };
  }
  const failures = evaluateContractGate(incomplete);
  assert.ok(
    failures.some((failure) => failure.includes("admin-6 result was missing")),
  );
});
