/**
 * Messages between the «Код» preview frame and the app. The page side is
 * `main/preview-bridge/*.js`, injected by the loopback preview server. Whatever a page
 * posts is untrusted: the frame checks the sender (`PreviewStage`), this parser checks
 * the shape and clamps every string.
 */
import type { PreviewPick } from "@zeno/contracts";
import { t, type Locale } from "./i18n.ts";

export const BRIDGE_SOURCE = "prsloy-preview";
export const HOST_SOURCE = "prsloy-host";

/** The pick event, shared with «Дизайн»: see `PreviewPick` in @zeno/contracts. */
export type PickedElement = PreviewPick;

/** What went wrong on the page (`main/preview-bridge/page-errors.js`). */
export type PageError = {
  kind: "script" | "promise" | "resource" | "console";
  message: string;
  /** Page-relative path of the script or file, when known. */
  file: string;
  line: number;
  column: number;
  page: string;
};

export type BridgeMessage =
  | { type: "ready" }
  | { type: "pick-cancel" }
  | ({ type: "picked" } & PickedElement)
  | ({ type: "error" } & PageError);

const ERROR_KINDS = new Set(["script", "promise", "resource", "console"]);

function count(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 0;
}

function str(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

export function parseBridgeMessage(data: unknown): BridgeMessage | undefined {
  if (!data || typeof data !== "object") return undefined;
  const raw = data as Record<string, unknown>;
  if (raw.source !== BRIDGE_SOURCE) return undefined;
  if (raw.type === "ready" || raw.type === "pick-cancel") return { type: raw.type };
  if (raw.type === "picked") {
    const tag = str(raw.tag, 40);
    const selector = str(raw.selector, 400);
    if (!tag || !selector) return undefined;
    const box = (raw.rect ?? {}) as Record<string, unknown>;
    const num = (value: unknown) =>
      typeof value === "number" && Number.isFinite(value) ? Math.round(value) : 0;
    const of = Math.max(1, count(raw.of));
    const picked: { type: "picked" } & PickedElement = {
      type: "picked",
      tag,
      selector,
      path: str(raw.path, 400),
      text: str(raw.text, 120),
      outerHTMLShort: str(raw.outerHTMLShort, 260),
      nth: Math.min(of, Math.max(1, count(raw.nth))),
      of,
      rect: { x: num(box.x), y: num(box.y), width: num(box.width), height: num(box.height) },
      page: str(raw.page, 300) || "/",
    };
    const file = str(raw.file, 300);
    if (file && count(raw.line) > 0) {
      picked.file = file;
      picked.line = count(raw.line);
      picked.col = count(raw.col);
      picked.exact = raw.exact !== false;
    }
    return picked;
  }
  if (raw.type === "error") {
    const message = str(raw.message, 500).trim();
    if (!message || typeof raw.kind !== "string" || !ERROR_KINDS.has(raw.kind)) return undefined;
    return {
      type: "error",
      kind: raw.kind as PageError["kind"],
      message,
      file: str(raw.file, 300),
      line: count(raw.line),
      column: count(raw.column),
      page: str(raw.page, 300) || "/",
    };
  }
  return undefined;
}

/** The banner keeps the first ten distinct errors of the page. */
export function addPageError(list: readonly PageError[], error: PageError): PageError[] {
  const same = (e: PageError) =>
    e.kind === error.kind &&
    e.message === error.message &&
    e.file === error.file &&
    e.line === error.line;
  if (list.length >= 10 || list.some(same)) return list as PageError[];
  return [...list, error];
}

/** One line per error for the owner and the agent: what, then where. */
export function pageErrorLine(locale: Locale, error: PageError): string {
  if (error.kind === "resource") {
    return t(locale, "features.errors.missing", { file: error.file || error.message });
  }
  if (!error.file) return error.message;
  const where = [error.file, error.line || "", error.column || ""].filter(Boolean).join(":");
  return `${error.message} (${where})`;
}

/** What «Починить» sends: the page and every error with its place. */
export function pageErrorsPrompt(locale: Locale, errors: readonly PageError[]): string {
  const page = pageName(errors[0]?.page ?? "/");
  return [
    t(locale, "features.errors.prompt", { page }),
    ...errors.map((error) => `- ${pageErrorLine(locale, error)}`),
  ].join("\n");
}

/** The command that turns picking on or off inside the frame. */
export function pickCommand(active: boolean) {
  return { source: HOST_SOURCE, type: "pick", active };
}

function pageName(page: string): string {
  try {
    return decodeURIComponent(page).replace(/^\/+/u, "") || "index.html";
  } catch {
    return page;
  }
}

/** Short name of a picked element for the panel: its text, else its tag. */
export function pickedLabel(picked: PickedElement): string {
  const text = picked.text.length > 40 ? `${picked.text.slice(0, 40)}…` : picked.text;
  return text ? `«${text}»` : `<${picked.tag}>`;
}

/**
 * The block the composer gets: where the element is, then «Что поменять здесь:» for the
 * owner to finish. Backticks in the page's HTML would break the inline code span.
 */
export function pickedPrompt(locale: Locale, picked: PickedElement): string {
  const code = (text: string) => `\`${text.replaceAll("`", "'")}\``;
  const lines = [`[${t(locale, "features.pick.block.title", { page: pageName(picked.page) })}]`];
  if (picked.file && picked.line) {
    const vars = { file: picked.file, line: String(picked.line) };
    lines.push(
      t(
        locale,
        picked.exact === false ? "features.pick.block.fileNear" : "features.pick.block.file",
        vars,
      ),
    );
  }
  lines.push(`${t(locale, "features.pick.block.element")}: ${code(picked.selector)}`);
  if (picked.text) lines.push(`${t(locale, "features.pick.block.text")}: ${picked.text}`);
  if (picked.outerHTMLShort) {
    lines.push(`${t(locale, "features.pick.block.code")}: ${code(picked.outerHTMLShort)}`);
  }
  if (picked.of > 1) {
    lines.push(
      t(locale, "features.pick.block.nth", { nth: String(picked.nth), of: String(picked.of) }),
    );
  }
  lines.push(`${t(locale, "features.pick.block.ask")} `);
  return lines.join("\n");
}

/** A picked block goes after whatever the owner already typed. */
export function appendToDraft(draft: string, block: string): string {
  return draft.trim() ? `${draft.trimEnd()}\n\n${block}` : block;
}
