/**
 * The harness's own tools in the feed (first-hour pass): «Вызывает request_secret» meant nothing to a
 * newcomer. Each known tool gets a plain verb, running and done; unknown tools keep the generic
 * «Вызывает {tool}». The harness's `label` never reaches the renderer, so the verbs live here.
 */
import { t, type Locale, type MessageKey } from "./i18n.ts";

const VERBS: Record<string, { running: MessageKey; done: MessageKey }> = {
  request_secret: { running: "tool.requestSecret.running", done: "tool.requestSecret.done" },
  ask_user: { running: "tool.askUser.running", done: "tool.askUser.done" },
  web_search: { running: "tool.webSearch.running", done: "tool.webSearch.done" },
  web_fetch: { running: "tool.webFetch.running", done: "tool.webFetch.done" },
  find_ready: { running: "tool.findReady.running", done: "tool.findReady.done" },
  explore: { running: "tool.explore.running", done: "tool.explore.done" },
  memory: { running: "tool.memory.running", done: "tool.memory.done" },
  bash_background: { running: "tool.bashBackground.running", done: "tool.bashBackground.done" },
  process: { running: "tool.process.running", done: "tool.process.done" },
  report_blocker: { running: "tool.reportBlocker.running", done: "tool.reportBlocker.done" },
};

/** The verb for a harness tool, or undefined for any other tool. */
export function harnessToolVerb(
  locale: Locale,
  toolName: string,
  status: "running" | "done" | "failed",
): string | undefined {
  const verbs = VERBS[toolName.trim()];
  if (!verbs) return undefined;
  if (status === "failed") return t(locale, "tool.failed", { action: t(locale, verbs.running) });
  return t(locale, verbs[status]);
}
