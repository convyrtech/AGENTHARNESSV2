import { defineConfig } from "vite-plus";

export default defineConfig({
  // recorded run fixtures stay byte-exact as written by run.py
  fmt: { ignorePatterns: ["apps/desktop/e2e/design/fixtures/**"] },
  lint: {
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
