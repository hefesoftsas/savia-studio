import { defineConfig } from "vitest/config";
import { pluginIdeRuntimePlugin } from "../../apps/admin/build/plugin-ide-runtime.ts";
export default defineConfig({
  plugins: [pluginIdeRuntimePlugin()],
  test: { include: ["test/**/*.test.ts"], testTimeout: 30000 },
});
