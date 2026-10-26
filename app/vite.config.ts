import { defineConfig } from "vite-plus";

export default defineConfig({
  // recorded run fixtures stay byte-exact as written by run.py; dogfood task folders are snapshots of real
  // work (a merge conflict with its markers, hidden characters) and must stay as they are
  fmt: {
    ignorePatterns: [
      "apps/desktop/e2e/design/fixtures/**",
      "packages/prsloy-harness/bench/tasks/dogfood-*/workspace/**",
    ],
  },
  lint: {
    ignorePatterns: ["packages/prsloy-harness/bench/tasks/dogfood-*/workspace/**"],
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: {
      "vite-plus/prefer-vite-plus-imports": "error",
      // dialogs.md: renderer must use ConfirmDialog/ErrorDialog, never window.confirm/alert/prompt.
      "no-alert": "error",
    },
    options: { typeAware: true, typeCheck: true },
  },
  run: {
    cache: true,
  },
});
