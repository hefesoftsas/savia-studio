import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";

const exec = promisify(execFile);
const outputs = { admin: "dist", "plugin-editor": "dist-plugin-editor" };
const publicBuildKeys = new Set([
  "CI",
  "NODE_ENV",
  "SAVIA_DEV_API_URL",
  "SAVIA_PLUGIN_EDITOR_DEPLOYMENT_URL",
]);

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

function inside(parent, path) {
  const suffix = relative(parent, path);
  return (
    suffix === "" ||
    (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix))
  );
}

function requireSeparateDirectories(root, directory) {
  if (inside(root, directory) || inside(directory, root))
    throw new Error(
      "Preview frontend artifact must be outside the source repository",
    );
}

async function buildIdentity({
  root,
  directory,
  repository,
  revision,
  tree,
  pnpmVersion,
  env = process.env,
}) {
  if (
    !/^[a-z\d_.-]+\/[a-z\d_.-]+$/i.test(repository ?? "") ||
    ![revision, tree].every((value) => /^[a-f\d]{40}$/.test(value ?? ""))
  )
    throw new Error(
      "An exact Preview repository, revision and Git tree are required",
    );
  const checkout = await realpath(root);
  const path = resolve(directory);
  requireSeparateDirectories(checkout, path);
  const git = await exec("git", ["rev-parse", "HEAD", "HEAD^{tree}"], {
    cwd: checkout,
  });
  if (!isDeepStrictEqual(git.stdout.trim().split("\n"), [revision, tree]))
    throw new Error(
      "The Preview frontend checkout has a different Git identity",
    );
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(pnpmVersion))
    throw new Error("The Preview frontend package manager version is invalid");
  const buildEnvironment = Object.keys(env)
    .filter((key) => key.startsWith("VITE_") || publicBuildKeys.has(key))
    .sort()
    .map((key) => [key, env[key]]);
  const source = join(checkout, "apps/admin");
  if ((await realpath(source)) !== source)
    throw new Error("The Preview frontend directory is outside the checkout");
  return {
    checkout,
    directory: path,
    source,
    manifest: {
      version: 1,
      repository,
      revision,
      tree,
      nodeVersion: process.version,
      pnpmVersion,
      buildEnvironmentSha256: sha256(JSON.stringify(buildEnvironment)),
    },
  };
}

async function copyOutput(source, target, name, files, rejectEmpty) {
  if (!(await lstat(source)).isDirectory())
    throw new Error("A Preview frontend output directory is missing or unsafe");
  const entries = await readdir(source, { withFileTypes: true });
  const before = files.length;
  let prepared = false;
  for (const entry of entries) {
    if (entry.name.includes("\\") || entry.isSymbolicLink())
      throw new Error(
        "Preview frontend paths cannot contain symbolic links or backslashes",
      );
    const input = join(source, entry.name);
    const output = join(target, entry.name);
    const path = `${name}/${entry.name}`;
    if (entry.isDirectory())
      await copyOutput(input, output, path, files, rejectEmpty);
    else if (entry.isFile()) {
      const contents = await readFile(input);
      if (!prepared) {
        await mkdir(target, { recursive: true, mode: 0o700 });
        prepared = true;
      }
      await writeFile(output, contents, { flag: "wx", mode: 0o600 });
      files.push({ path, sha256: sha256(contents) });
    } else throw new Error("Unexpected Preview frontend file type");
  }
  if (rejectEmpty && files.length === before)
    throw new Error("Unexpected empty directory in Preview frontend artifact");
}

function ordered(files) {
  return files.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
}

export async function stagePreviewFrontendArtifact(options) {
  const { checkout, directory, source, manifest } =
    await buildIdentity(options);
  await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
  requireSeparateDirectories(
    checkout,
    join(await realpath(dirname(directory)), basename(directory)),
  );
  await mkdir(directory, { mode: 0o700 });
  try {
    const files = [];
    for (const [name, output] of Object.entries(outputs)) {
      const before = files.length;
      await copyOutput(
        join(source, output),
        join(directory, name),
        name,
        files,
        false,
      );
      if (files.length === before)
        throw new Error("Missing Preview frontend build output");
    }
    const staged = { ...manifest, files: ordered(files) };
    await writeFile(
      join(directory, "manifest.json"),
      JSON.stringify(staged) + "\n",
      {
        flag: "wx",
        mode: 0o600,
      },
    );
    return staged;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function restorePreviewFrontendArtifact(options) {
  const { checkout, directory, source, manifest } =
    await buildIdentity(options);
  if (!(await lstat(directory)).isDirectory())
    throw new Error("Unsafe Preview frontend artifact directory");
  const artifact = await realpath(directory);
  requireSeparateDirectories(checkout, artifact);
  const expectedEntries = [...Object.keys(outputs), "manifest.json"].sort();
  if (!isDeepStrictEqual((await readdir(artifact)).sort(), expectedEntries))
    throw new Error("Unexpected entry in Preview frontend artifact");
  const metadataPath = join(artifact, "manifest.json");
  if (!(await lstat(metadataPath)).isFile())
    throw new Error("Unsafe Preview frontend manifest");
  const { files: expectedFiles, ...metadata } = JSON.parse(
    await readFile(metadataPath, "utf8"),
  );
  if (!Array.isArray(expectedFiles) || !isDeepStrictEqual(metadata, manifest))
    throw new Error(
      "Preview frontend artifact metadata does not match this build",
    );

  const temporary = await mkdtemp(join(source, ".preview-frontend-restore-"));
  const created = [];
  try {
    const files = [];
    for (const [name, output] of Object.entries(outputs))
      await copyOutput(
        join(artifact, name),
        join(temporary, output),
        name,
        files,
        true,
      );
    if (!isDeepStrictEqual(ordered(files), expectedFiles))
      throw new Error(
        "Preview frontend files do not match the manifest integrity hashes",
      );

    for (const output of Object.values(outputs)) {
      const destination = join(source, output);
      await mkdir(destination, { mode: 0o700 });
      created.push(destination);
      const staged = join(temporary, output);
      for (const entry of await readdir(staged))
        await rename(join(staged, entry), join(destination, entry));
    }
    return { ...manifest, files };
  } catch (error) {
    for (const destination of created.reverse())
      await rm(destination, { recursive: true, force: true });
    throw error;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
