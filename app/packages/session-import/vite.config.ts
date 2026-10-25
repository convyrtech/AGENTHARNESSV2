import { defineConfig } from "vite-plus";

export default defineConfig({
  // the round-trip test starts a real pi runtime; slow on a loaded CI runner
  test: { testTimeout: 30_000 },
});
