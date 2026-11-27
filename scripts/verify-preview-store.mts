import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { releaseArtifacts } from "./deploy-store-plugins.mjs";
import { extensionObjectProvisioningState } from "../packages/studio-server/src/extension-object-requirements.ts";
import { canonicalJson } from "../packages/studio-shared/src/solution-package.ts";
import {
  pluginStoreManifestSchema,
  sanitizeStoreCollection,
  storeJsonSchema,
} from "../packages/studio-shared/src/plugin-store.ts";

type Artifact = {
  path?: string;
  manifest: Record<string, unknown> & {
    id: string;
    version: string;
    requires: string[];
  };
  optional: boolean;
  bytes?: Uint8Array;
  storeJson?: unknown;
};

type CatalogRow = {
  tenant_id: string;
  id: string;
  version: string;
  manifest: string;
  sha256: string;
  store_json: string | null;
};

type InstallationRow = {
  tenant_id: string;
  id: string;
  version: string;
  enabled: number;
  manifest: string;
};

type ObjectRow = {
  tenant_id: string;
  name: string;
  label: string;
  description: string;
  config: string;
  version: number;
};

type PreviewSnapshot = {
  tenants: unknown;
  catalog: unknown;
  installations: unknown;
  objects: unknown;
};

const fixedSnapshotSql = `
WITH excluded_scopes AS (
  SELECT value FROM json_each(?)
), tenant_scopes AS (
  SELECT 'tenant:' || id AS tenant_id FROM tenants
  WHERE NOT EXISTS (
    SELECT 1 FROM excluded_scopes WHERE value = 'tenant:' || id
  )
), target_ids AS (
  SELECT value AS id FROM json_each(?)
), target_objects AS (
  SELECT value AS name FROM json_each(?)
)
SELECT
  (SELECT json_group_array(tenant_id) FROM tenant_scopes) AS tenants,
  (SELECT json_group_array(json_object(
    'tenant_id', a.tenant_id, 'id', a.id, 'version', a.version,
    'manifest', a.manifest, 'sha256', a.sha256, 'store_json', a.store_json
  )) FROM plugin_store_artifacts a
    JOIN tenant_scopes t ON t.tenant_id = a.tenant_id
    JOIN target_ids i ON i.id = a.id) AS catalog,
  (SELECT json_group_array(json_object(
    'tenant_id', i.tenant_id, 'id', i.id, 'version', i.version,
    'enabled', i.enabled, 'manifest', i.manifest
  )) FROM studio_extension_installations i
    JOIN tenant_scopes t ON t.tenant_id = i.tenant_id
    JOIN target_ids d ON d.id = i.id) AS installations,
  (SELECT json_group_array(json_object(
    'tenant_id', o.tenant_id, 'name', o.name, 'label', o.label,
    'description', o.description, 'config', o.config, 'version', o.version
  )) FROM studio_objects o
    JOIN tenant_scopes t ON t.tenant_id = o.tenant_id
    JOIN target_objects n ON n.name = o.name) AS objects`;

export function parseExcludedTenants(value: string): string[] {
  const scopes = value
    .split(",")
    .map((scope) => scope.trim())
    .filter(Boolean);
  if (scopes.some((scope) => !/^tenant:[1-9]\d*$/.test(scope)))
    throw new Error("invalid excluded tenant scopes");
  return [...new Set(scopes)];
}

function parsedJson(value: unknown): unknown | null {
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function compareVersions(left: string, right: string): number | null {
  const pattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
  const a = left.match(pattern);
  const b = right.match(pattern);
  if (!a || !b) return null;
  for (let index = 1; index <= 3; index += 1) {
    const x = BigInt(a[index]);
    const y = BigInt(b[index]);
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function artifactBytes(artifact: Artifact): Uint8Array | null {
  if (artifact.bytes) return artifact.bytes;
  if (!artifact.path) return null;
  try {
    return readFileSync(artifact.path);
  } catch {
    return null;
  }
}

function artifactStore(artifact: Artifact): unknown | null {
  if (artifact.storeJson) return artifact.storeJson;
  if (!artifact.path) return null;
  try {
    const entries = execFileSync("unzip", ["-Z1", artifact.path], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).split(/\r?\n/);
    if (!entries.includes("store.json")) return null;
    return JSON.parse(
      execFileSync("unzip", ["-p", artifact.path, "store.json"], {
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
      }),
    );
  } catch {
    return null;
  }
}

function expectedArtifactData(artifacts: Artifact[]) {
  if (!Array.isArray(artifacts) || !artifacts.length) return null;
  const ids = new Set<string>();
  const expected = [];
  for (const artifact of artifacts) {
    const manifest = pluginStoreManifestSchema.safeParse(artifact?.manifest);
    if (!manifest.success || ids.has(manifest.data.id)) return null;
    ids.add(manifest.data.id);
    const bytes = artifactBytes(artifact);
    if (!bytes) return null;
    const rawStore = artifact.optional ? null : artifactStore(artifact);
    const store =
      rawStore === null ? null : storeJsonSchema.safeParse(rawStore);
    if (store && !store.success) return null;
    expected.push({
      id: manifest.data.id,
      version: manifest.data.version,
      manifest: manifest.data,
      digest: createHash("sha256").update(bytes).digest("hex"),
      optional: artifact.optional,
      requires: manifest.data.requires,
      store: store?.data ?? null,
    });
  }
  return expected;
}

function validTenantScope(value: unknown): value is string {
  return typeof value === "string" && /^tenant:(0|[1-9]\d*)$/.test(value);
}

export function evaluatePreviewStore(input: {
  artifacts: Artifact[];
  snapshot: PreviewSnapshot;
  excludedTenants: string[];
}): boolean {
  return evaluateAgainstExpected(input, expectedArtifactData(input.artifacts));
}

function evaluateAgainstExpected(
  input: {
    artifacts: Artifact[];
    snapshot: PreviewSnapshot;
    excludedTenants: string[];
  },
  expected: ReturnType<typeof expectedArtifactData>,
): boolean {
  try {
    if (!expected) return false;
    const { tenants, catalog, installations, objects } = input.snapshot;
    if (
      !Array.isArray(tenants) ||
      !Array.isArray(catalog) ||
      !Array.isArray(installations) ||
      !Array.isArray(objects)
    )
      return false;
    const eligible = tenants.filter(
      (scope): scope is string =>
        validTenantScope(scope) && !input.excludedTenants.includes(scope),
    );
    if (
      !eligible.length ||
      eligible.length !== tenants.length ||
      new Set(eligible).size !== eligible.length
    )
      return false;
    const byId = new Map(expected.map((artifact) => [artifact.id, artifact]));
    const catalogRows = catalog as CatalogRow[];
    const installationRows = installations as InstallationRow[];
    const objectRows = objects as ObjectRow[];
    const requiredArtifacts = expected.filter((artifact) => !artifact.optional);
    const requirements = requiredArtifacts.flatMap((artifact) => {
      if (artifact.requires.length !== 0 || !artifact.store) throw new Error();
      return artifact.store.collections.map((collection) => ({
        id: artifact.id,
        ...sanitizeStoreCollection(collection),
      }));
    });
    const allTenantIds = new Set(eligible);
    if (
      catalogRows.some(
        (row) => !row || !allTenantIds.has(row.tenant_id) || !byId.has(row.id),
      ) ||
      installationRows.some(
        (row) => !row || !allTenantIds.has(row.tenant_id) || !byId.has(row.id),
      ) ||
      objectRows.some(
        (row) =>
          !row ||
          !allTenantIds.has(row.tenant_id) ||
          !requirements.some(
            (requirement) => requirement.object.name === row.name,
          ),
      )
    )
      return false;
    for (const tenant of eligible) {
      for (const artifact of expected) {
        const rows = catalogRows.filter(
          (row) => row.tenant_id === tenant && row.id === artifact.id,
        );
        if (!rows.length) return false;
        let latest = rows[0].version;
        for (const row of rows) {
          const comparison = compareVersions(row.version, latest);
          if (comparison === null) return false;
          if (comparison > 0) latest = row.version;
          const manifest = parsedJson(row.manifest);
          if (
            typeof row.sha256 !== "string" ||
            !/^[a-f0-9]{64}$/.test(row.sha256) ||
            !manifest ||
            typeof manifest !== "object" ||
            (manifest as { id?: unknown }).id !== row.id ||
            (manifest as { version?: unknown }).version !== row.version
          )
            return false;
        }
        const exact = rows.filter((row) => row.version === artifact.version);
        if (
          latest !== artifact.version ||
          exact.length !== 1 ||
          exact[0].sha256 !== artifact.digest ||
          canonicalJson(parsedJson(exact[0].manifest)) !==
            canonicalJson(artifact.manifest) ||
          (!artifact.optional &&
            canonicalJson(
              storeJsonSchema.parse(parsedJson(exact[0].store_json)),
            ) !== canonicalJson(artifact.store))
        )
          return false;
      }
      for (const required of requiredArtifacts) {
        const requiredInstallations = installationRows.filter(
          (row) => row.tenant_id === tenant && row.id === required.id,
        );
        if (
          requiredInstallations.length !== 1 ||
          requiredInstallations[0].version !== required.version ||
          requiredInstallations[0].enabled !== 1 ||
          canonicalJson(parsedJson(requiredInstallations[0].manifest)) !==
            canonicalJson(required.manifest)
        )
          return false;
      }
      for (const requirement of requirements) {
        const matches = objectRows.filter(
          (row) =>
            row.tenant_id === tenant && row.name === requirement.object.name,
        );
        if (matches.length !== 1) return false;
        const config = parsedJson(matches[0].config);
        if (!config) return false;
        const state = extensionObjectProvisioningState(config, requirement);
        if (!state.compatible || state.optionalFieldAdditions.length)
          return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function parseCloudflareResult(payload: unknown): PreviewSnapshot | null {
  const envelope = payload && typeof payload === "object" ? payload : null;
  if (!envelope || typeof envelope !== "object") return null;
  const outer = envelope as {
    success?: unknown;
    result?: unknown;
    results?: unknown;
  };
  if (
    outer.success !== true ||
    !Array.isArray(outer.result) ||
    outer.result.length !== 1
  )
    return null;
  const inner = outer.result[0];
  if (
    !inner ||
    typeof inner !== "object" ||
    (inner as { success?: unknown }).success !== true
  )
    return null;
  const row = (inner as { results?: unknown }).results;
  if (
    !Array.isArray(row) ||
    row.length !== 1 ||
    !row[0] ||
    typeof row[0] !== "object"
  )
    return null;
  const snapshot = row[0] as Record<string, unknown>;
  const parsed: Record<string, unknown> = {};
  for (const key of ["tenants", "catalog", "installations", "objects"]) {
    parsed[key] = parsedJson(snapshot[key]);
    if (!Array.isArray(parsed[key])) return null;
  }
  return parsed as unknown as PreviewSnapshot;
}

export async function verifyPreviewStore(input: {
  env: Record<string, string | undefined>;
  artifacts: Artifact[];
  fetch?: typeof fetch;
  appendOutput?: (value: string) => void;
  log?: (message: string) => void;
}): Promise<boolean> {
  const log = input.log ?? console.log;
  let current = false;
  try {
    const { env } = input;
    if (env.SAVIA_DEPLOY_ENVIRONMENT !== "preview")
      throw new Error("invalid environment");
    const account = env.CLOUDFLARE_ACCOUNT_ID?.trim();
    const token = env.CLOUDFLARE_API_TOKEN?.trim();
    const database = env.CLOUDFLARE_DATABASE_ID?.trim();
    const outputPath = env.GITHUB_OUTPUT?.trim();
    if (!account || !token || !database || !outputPath)
      throw new Error("missing configuration");
    const excludedTenants = parseExcludedTenants(
      env.SAVIA_PREVIEW_STORE_EXCLUDED_TENANTS ?? "",
    );
    const expected = expectedArtifactData(input.artifacts);
    if (!expected) throw new Error("invalid local artifacts");
    const collectionNames = [
      ...new Set(
        expected.flatMap((artifact) => {
          if (artifact.optional || !artifact.store) return [];
          return artifact.store.collections.map(
            ({ object }) => (object as { name: string }).name,
          );
        }),
      ),
    ];
    const response = await (input.fetch ?? fetch)(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/d1/database/${encodeURIComponent(database)}/query`,
      {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          sql: fixedSnapshotSql,
          params: [
            JSON.stringify(excludedTenants),
            JSON.stringify(expected.map(({ id }) => id)),
            JSON.stringify(collectionNames),
          ],
        }),
      },
    );
    if (!response.ok) throw new Error("provider request failed");
    const snapshot = parseCloudflareResult(await response.json());
    if (!snapshot) throw new Error("provider response was invalid");
    current = evaluateAgainstExpected(
      {
        artifacts: input.artifacts,
        snapshot,
        excludedTenants,
      },
      expected,
    );
    log(
      current
        ? "Preview store catalog is current."
        : "Preview store catalog needs publication.",
    );
  } catch {
    log("Preview store catalog could not be verified; publication will run.");
  }
  try {
    (
      input.appendOutput ??
      ((value) => appendFileSync(input.env.GITHUB_OUTPUT!, `${value}\n`))
    )(`current=${current}`);
  } catch {
    log("Preview store verification output could not be written.");
    return false;
  }
  return current;
}

async function main() {
  try {
    const artifacts = releaseArtifacts();
    await verifyPreviewStore({ env: process.env, artifacts });
  } catch {
    console.log(
      "Preview store catalog could not be verified; publication will run.",
    );
    try {
      appendFileSync(process.env.GITHUB_OUTPUT!, "current=false\n");
    } catch {
      console.log("Preview store verification output could not be written.");
    }
  }
}

if (process.argv[1]?.endsWith("verify-preview-store.mts")) await main();
