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
    expect(config.define?.["import.meta.env.VITE_SAVIA_FLOWS_DISABLED"]).toBe(
      JSON.stringify("true"),
    );
    expect(
      config.plugins.some(({ name }) => name === "savia-flows-assets"),
    ).toBe(false);
  } finally {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});

it.each([
  { command: "serve" as const, enabled: "0", disabled: true },
  { command: "serve" as const, enabled: "1", disabled: false },
  { command: "build" as const, enabled: "0", disabled: false },
])(
  "propagates Flows availability for $command with local Flows $enabled",
  async ({ command, enabled, disabled }) => {
    vi.stubEnv("SAVIA_FLOWS_ENABLED", enabled);
    vi.stubEnv("SAVIA_CI_FLOWS_ENABLED", undefined);
    try {
      const config = await resolveConfig(
        {
          configFile: fileURLToPath(
            new URL("../vite.config.ts", import.meta.url),
          ),
          logLevel: "silent",
        },
        command,
      );
      expect(config.define?.["import.meta.env.VITE_SAVIA_FLOWS_DISABLED"]).toBe(
        disabled ? JSON.stringify("true") : undefined,
      );
      expect(
        config.plugins.some(({ name }) => name === "savia-flows-assets"),
      ).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  },
);
