/**
 * Messages between the «Код» preview frame and the app. The page side is
 * `main/preview-bridge/*.js`, injected by the loopback preview server. Whatever a page
 * posts is untrusted: the frame checks the sender (`PreviewStage`), this parser checks
 * the shape and clamps every string.
 */
import { t, type Locale } from "./i18n.ts";

export const BRIDGE_SOURCE = "prsloy-preview";
export const HOST_SOURCE = "prsloy-host";

export type PickedElement = {
  tag: string;
  /** CSS path that finds exactly this element. */
  selector: string;
  /** Readable breadcrumb, up to five steps. */
  path: string;
  text: string;
  /** Start of the element's outerHTML. */
  html: string;
  /** Page path inside the preview, e.g. `/index.html`. */
  page: string;
};

export type BridgeMessage =
  | { type: "ready" }
  | { type: "pick-cancel" }
  | ({ type: "picked" } & PickedElement);

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
    return {
      type: "picked",
      tag,
      selector,
      path: str(raw.path, 400),
      text: str(raw.text, 120),
      html: str(raw.html, 310),
      page: str(raw.page, 300) || "/",
    };
  }
  return undefined;
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
  const lines = [
    `[${t(locale, "features.pick.block.title", { page: pageName(picked.page) })}]`,
    `${t(locale, "features.pick.block.element")}: \`${picked.selector.replaceAll("`", "'")}\``,
  ];
  if (picked.text) lines.push(`${t(locale, "features.pick.block.text")}: ${picked.text}`);
  if (picked.html) {
    lines.push(`${t(locale, "features.pick.block.code")}: \`${picked.html.replaceAll("`", "'")}\``);
  }
  lines.push(`${t(locale, "features.pick.block.ask")} `);
  return lines.join("\n");
}

/** A picked block goes after whatever the owner already typed. */
export function appendToDraft(draft: string, block: string): string {
  return draft.trim() ? `${draft.trimEnd()}\n\n${block}` : block;
}
