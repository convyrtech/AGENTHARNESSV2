import { defineConfig } from "vite-plus";

export default defineConfig({
  // these tests start real pi runtimes; on a loaded CI runner that exceeds vitest's 5 s default
  test: { testTimeout: 30_000 },
});
