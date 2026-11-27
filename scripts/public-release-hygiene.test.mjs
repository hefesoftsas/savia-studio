import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const checkout = { cwd: root };
const trackedFiles = execFileSync("git", ["ls-files", "-z"], {
  ...checkout,
  encoding: "utf8",
})
  .split("\0")
  .filter(Boolean);

function firstPartyPluginPaths(files) {
  return files.filter(
    (path) =>
      path.startsWith(".hosted-plugins/") ||
      path.startsWith("integrations/bruno/") ||
      path.startsWith("solutions/") ||
      path.startsWith("deployment/plugins/") ||
      (/^store-ports\/[^/]+\//.test(path) &&
        !path.startsWith("store-ports/http-echo/")) ||
      /\.store\.zip(?:\.sha256)?$/i.test(path),
  );
}
assert.deepEqual(
  firstPartyPluginPaths([
    "packages/plugin-sdk/src/index.ts",
    "store-ports/README.md",
    "store-ports/http-echo/entry.js",
    "store-ports/http-echo/savia-extension.json",
    "store-ports/internal-example/entry.js",
    "store-ports/internal-example/assets/ui.js",
    "artifacts/internal-example-1.0.0.store.zip",
    "artifacts/internal-example-1.0.0.store.zip.sha256",
  ]),
  [
    "store-ports/internal-example/entry.js",
    "store-ports/internal-example/assets/ui.js",
    "artifacts/internal-example-1.0.0.store.zip",
    "artifacts/internal-example-1.0.0.store.zip.sha256",
  ],
  "release checks must catch packaged artifacts and incomplete store ports",
);

assert.deepEqual(
  firstPartyPluginPaths(trackedFiles),
  [],
  "First-party plugin source and rollout files belong in the private repository",
);

function locallyModifiedPaths(repository) {
  return new Set(
    execFileSync("git", ["diff", "--name-only", "--no-renames", "-z", "--"], {
      ...repository,
      encoding: "utf8",
    })
      .split("\0")
      .filter(Boolean),
  );
}

function candidateSnapshots(repository, path, modifiedPaths) {
  let working;
  try {
    working = readFileSync(join(repository.cwd, path));
  } catch {
    // The staged file can still exist when the checkout copy is missing.
  }
  if (working && !modifiedPaths.has(path)) return [working];
  const staged = execFileSync("git", ["cat-file", "blob", `:${path}`], {
    ...repository,
    maxBuffer: Infinity,
  });
  return working && !working.equals(staged) ? [staged, working] : [staged];
}

test("reads both the staged blob and the edited tracked file", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "savia-public-release-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const localGitOptions = new Set(
    execFileSync("git", ["rev-parse", "--local-env-vars"], {
      encoding: "utf8",
    })
      .trim()
      .split("\n"),
  );
  const fixture = {
    cwd: directory,
    env: Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !localGitOptions.has(key)),
    ),
  };
  execFileSync("git", ["init", "--quiet"], fixture);
  const path = "example#draft.txt";
  writeFileSync(join(directory, path), "staged fixture");
  execFileSync("git", ["add", "--", path], fixture);
  writeFileSync(join(directory, path), "working fixture");

  assert.deepEqual(
    candidateSnapshots(fixture, path, locallyModifiedPaths(fixture)).map(
      (contents) => contents.toString("utf8"),
    ),
    ["staged fixture", "working fixture"],
  );
});

function isEmptyProviderData(bytes, expectEmptyCatalog) {
  try {
    const value = JSON.parse(bytes.toString("utf8"));
    return expectEmptyCatalog
      ? Array.isArray(value) && value.length === 0
      : value === null;
  } catch {
    return false;
  }
}

const modifiedPaths = locallyModifiedPaths(checkout);
for (const [file, emptyCatalog, label] of [
  ["catalog.json", true, "definitions"],
  ["seed.json", false, "seeds"],
]) {
  const path = `apps/savia-request/src/server/${file}`;
  assert.ok(trackedFiles.includes(path), `Missing public stub ${path}`);
  assert.ok(
    candidateSnapshots(checkout, path, modifiedPaths).every((bytes) =>
      isEmptyProviderData(bytes, emptyCatalog),
    ),
    `Hosted provider ${label} are supplied only during deployment assembly`,
  );
}

const dumpExtensions =
  /\.(?:dump|bak|backup|sqlite|sqlite3|db|sql\.gz|dump\.gz|tar\.gz)$/i;
const vehicleRegistration = /\b(?:[A-Z]{3}\d{2}[A-Z0-9]|[A-Z]{4}\d{2})\b/g;
const technicalIdentifiers = new Set(["AES128", "SHA256"]);

// This exact third-party Lottie build contains math terms that resemble private
// identifiers and registration values. Any changed build is scanned as usual.
// The exact generated native lockfile also contains a public numeric crate name
// resembling a restricted identifier; changed lockfiles are scanned normally.
const approvedVendorHashes = new Map([
  [
    "apps/companion/src-tauri/Cargo.lock",
    "fd371fd03e94b8eb9d6fe6c14399919dccf3b147d383cdf7582c27045e22b4bb",
  ],
  [
    "apps/admin/public/login/lottie-light.min.js",
    "9588432bec30c8ef8200bac4a67d8aaad881047bc2a6c9fa624d90ec96402410",
  ],
  // These exact, unmodified Dafthunk files use graphics transformations and
  // technical test terminology. Each digest also matches UPSTREAM.json.
  // Any adaptation is scanned normally, including changes to these files.
  [
    "apps/flows/app/public/logo.svg",
    "0cb8fed28ccfb7dce2128823d5c07751b05d36ec070d5323b8d3361ac7375168",
  ],
  [
    "apps/flows/packages/runtime/src/nodes/3d/csg-rotate-node.ts",
    "ee7fb6782044c05cadfcc67544d9311cab2594366ff87734eec0470af9367929",
  ],
  [
    "apps/flows/packages/runtime/src/nodes/3d/csg-scale-node.ts",
    "0e6b9e90c69a0a6c0a2b1f63f410c6736bba34a618c902d0435dca18571327d6",
  ],
  [
    "apps/flows/packages/runtime/src/nodes/3d/csg-translate-node.ts",
    "5e056763013b1904e6c791516a8ea937105a0eb1265a8c7311228ffc5e35fe9c",
  ],
  [
    "apps/flows/packages/runtime/src/nodes/3d/csg-utils.ts",
    "41ee0786562b7b957c1b3a7a0fcebf0a9ae53fb9f0c592043ed004ec5bd41292",
  ],
  [
    "apps/flows/packages/runtime/src/nodes/geo/shortest-path-node.ts",
    "33e59afe9167f0f4ec224c8a26b84b783a67270a35021fa340c1012e0c1095bf",
  ],
  [
    "apps/flows/packages/runtime/src/validate-workflow.test.ts",
    "fbef48d588ffeaad3e705e03b633be5974f6d7cfb591651fe8dd54d1185d84a7",
  ],
]);

// Character codes keep disallowed identifiers out of the public search index.
const privateIdentifiers = [
  [109, 97, 116, 114, 105, 120],
  [105, 108, 97, 111, 115],
  [115, 105, 110, 101, 114, 103, 105, 97, 115],
  [115, 121, 110, 101, 114, 103, 105, 97, 115],
  [108, 117, 105, 115, 97],
  [100, 117, 113, 117, 101],
  [97, 108, 101, 106, 97, 110, 100, 114, 111],
].map((codes) => String.fromCharCode(...codes));
// GitHub Actions uses a reserved strategy expansion keyword that also matches
// one of the restricted names. Ignore only its YAML key and expression access;
// prose, values, paths, and every other private identifier remain scanned.
function searchableWorkflowContent(file, content) {
  if (!/^\.github\/workflows\/[^/]+\.ya?ml$/.test(file)) return content;
  const keyword = String.fromCharCode(109, 97, 116, 114, 105, 120);
  return content
    .replace(new RegExp(`(^[ \t]*)${keyword}(?=:[ \t]*(?:#.*)?$)`, "gm"), "$1")
    .replace(/\$\{\{[\s\S]*?\}\}/g, (expression) =>
      expression.replace(
        new RegExp(`\\b${keyword}(?=\\.[A-Za-z_]\\w*)`, "g"),
        "",
      ),
    );
}

const workflowKeyword = String.fromCharCode(109, 97, 116, 114, 105, 120);
const workflowPath = ".github/workflows/example.yml";
assert.equal(
  searchableWorkflowContent(
    workflowPath,
    `    ${workflowKeyword}:\n      include: []\nname: \${{ ${workflowKeyword}.id }}\n`,
  ).includes(workflowKeyword),
  false,
  "reserved workflow syntax must not be mistaken for private data",
);
for (const [file, content] of [
  [workflowPath, `name: ${workflowKeyword}`],
  [workflowPath, `# ${workflowKeyword}`],
  ["docs/example.md", `    ${workflowKeyword}:`],
]) {
  assert.ok(searchableWorkflowContent(file, content).includes(workflowKeyword));
}

const privateIdentifierFiles = new Set();
const dumpFiles = trackedFiles.filter((file) => dumpExtensions.test(file));
const registrationFiles = new Set();
const privateKeyFiles = new Set();
const localConfigFiles = trackedFiles.filter((file) =>
  /(?:^|\/)(?:\.env(?!\.example$)|\.dev\.vars|infra\/secrets\/|\.wrangler\/)|wrangler\.(?:production|preview)\.jsonc$/.test(
    file,
  ),
);

function scanFile(file, bytes) {
  const approvedHash = approvedVendorHashes.get(file);
  if (
    approvedHash &&
    createHash("sha256").update(bytes).digest("hex") === approvedHash
  )
    return;

  const pathHasPrivateIdentifier = privateIdentifiers.some((value) =>
    file.toLowerCase().includes(value),
  );

  // Binary media has arbitrary byte sequences and is not source text to scan.
  if (bytes.includes(0)) {
    if (pathHasPrivateIdentifier) privateIdentifierFiles.add(file);
    return;
  }

  const content = bytes.toString("utf8");

  if (
    /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/.test(content)
  )
    privateKeyFiles.add(file);

  if (
    pathHasPrivateIdentifier ||
    privateIdentifiers.some((value) =>
      searchableWorkflowContent(file, content).toLowerCase().includes(value),
    )
  ) {
    privateIdentifierFiles.add(file);
  }

  const matches = [...content.matchAll(vehicleRegistration)]
    .map((match) => match[0])
    .filter((value) => !technicalIdentifiers.has(value));
  if (matches.length) registrationFiles.add(file);
}

for (const file of trackedFiles) {
  for (const bytes of candidateSnapshots(checkout, file, modifiedPaths))
    scanFile(file, bytes);
}

assert.deepEqual(dumpFiles, [], "tracked dump files must not be published");
assert.deepEqual(
  [...registrationFiles],
  [],
  "tracked source must not retain literal vehicle registration values",
);

assert.deepEqual(
  [...privateKeyFiles],
  [],
  "private keys must not be published",
);
assert.deepEqual(
  localConfigFiles,
  [],
  "local configuration must not be published",
);

assert.deepEqual(
  [...privateIdentifierFiles],
  [],
  "private identifiers must not be published",
);
