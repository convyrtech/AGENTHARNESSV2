/**
 * The `ZENO_AUTO_EXTENSION_UI=1` test backdoor: answer an extension's dialog request
 * without a window, so e2e runs that are not about dialogs are not blocked by one.
 *
 * Kept out of `main/index.ts` (which is over its line budget) and out of the product path:
 * without that environment variable nothing here is called.
 */
export function autoExtensionUiValue(method: string, args: unknown): unknown {
  const record = typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
  if (method === "confirm") return true;
  if (method === "select" && Array.isArray(record.options)) return record.options[0];
  if (method === "input" || method === "editor") return "zeno-test-input";
  return undefined;
}
