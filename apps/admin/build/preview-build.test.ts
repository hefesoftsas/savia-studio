// @vitest-environment node
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveConfig } from "vite";
import { expect, it, vi } from "vitest";

it("builds an isolated Preview without the checkout's API URL or Flows assets", async () => {
  const root = await mkdtemp(join(tmpdir(), "savia-admin-preview-"));
  try {
    await writeFile(
      join(root, ".env.local"),
      "VITE_SAVIA_API_URL=http://127.0.0.1:8787\n",
    );
    vi.stubEnv("VITE_SAVIA_API_URL", undefined);
    vi.stubEnv("SAVIA_ADMIN_IGNORE_ENV_FILES", "true");
    vi.stubEnv("SAVIA_CI_FLOWS_ENABLED", "false");
    const assetsDir = join(root, "isolated-output");
    vi.stubEnv("SAVIA_ADMIN_OUT_DIR", assetsDir);
    const config = await resolveConfig(
      {
        root,
        configFile: fileURLToPath(
          new URL("../vite.config.ts", import.meta.url),
        ),
        logLevel: "silent",
      },
      "build",
    );
    expect(config.env.VITE_SAVIA_API_URL).toBeUndefined();
    expect(config.build.outDir).toBe(assetsDir);
    expect(
      config.plugins.some(({ name }) => name === "savia-flows-assets"),
    ).toBe(false);
  } finally {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});
