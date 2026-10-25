/**
 * «Править» in «Дизайн», text without a model (research/20 §4): the owner retyped a piece of text on
 * the page; write it into the source only when the place is certain. By the rules of Open CoDesign's
 * `SOURCE_EDITING.md`: the element is found by its exact source position (parse5, the same marks the
 * preview gave the page), never by searching for a similar line; it must hold plain text only, and
 * that text must be what the owner saw. Anything else is refused with a reason, and the owner says
 * it in words through «Править» instead. Text that motion redraws (`data-move`) is never touched.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { parse } from "parse5";
import { decodePage } from "../preview-bridge/source-tags.ts";
import { insideRoot } from "./paths.ts";

export type TextEdit = { file: string; line: number; col: number; before: string; after: string };
export type TextEditResult = { ok: true } | { ok: false; error: string };

type Attr = { name: string; value: string };
type Node = {
  nodeName: string;
  value?: string;
  attrs?: Attr[];
  childNodes?: Node[];
  content?: Node;
  parentNode?: Node;
  sourceCodeLocation?: {
    startOffset: number;
    endOffset: number;
    startTag?: { startLine: number; startCol: number };
  };
};

const MAX_TEXT = 2000;
const NOT_TEXT = new Set(["script", "style", "textarea", "title", "template"]);

/** What the renderer sends, clamped; undefined when it is not a text edit at all. */
export function textEditArg(raw: unknown): TextEdit | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const whole = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : 0);
  const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
  const edit = {
    file: str(r.file, 300),
    line: whole(r.line),
    col: whole(r.col),
    before: str(r.before, MAX_TEXT),
    after: str(r.after, MAX_TEXT + 1),
  };
  return edit.file && edit.line && edit.col ? edit : undefined;
}

const squash = (text: string) => text.replace(/\s+/gu, " ").trim();

function escapeText(text: string): string {
  return text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}

function find(node: Node, line: number, col: number): Node | undefined {
  const start = node.sourceCodeLocation?.startTag;
  if (start && start.startLine === line && start.startCol === col) return node;
  for (const child of node.childNodes ?? []) {
    const hit = find(child, line, col);
    if (hit) return hit;
  }
  return node.content ? find(node.content, line, col) : undefined;
}

function moves(node: Node | undefined): boolean {
  for (let n = node; n; n = n.parentNode) {
    if (n.attrs?.some((a) => a.name === "data-move")) return true;
  }
  return false;
}

/** Write the owner's new text into `<siteDir>/<file>` at `line:col`, or say why not. */
export function applyTextEdit(siteDir: string, edit: TextEdit): TextEditResult {
  const after = squash(edit.after);
  if (!after)
    return { ok: false, error: "Пустой текст так не убрать — скажите словами через «Править»" };
  if (after.length > MAX_TEXT)
    return { ok: false, error: "Слишком длинный текст для правки на месте" };
  const path = insideRoot(siteDir, edit.file);
  if (!path) return { ok: false, error: "Этот текст не из файлов страницы" };
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch {
    return { ok: false, error: "Этот текст не из файлов страницы" };
  }
  const page = decodePage(bytes);
  if (page.encoding !== "utf8") {
    return { ok: false, error: "Файл страницы не в UTF-8 — скажите словами через «Править»" };
  }
  const html = page.text;
  const document = parse(html, { sourceCodeLocationInfo: true }) as unknown as Node;
  const element = find(document, edit.line, edit.col);
  const stale = "Страница поменялась — откройте «Править» заново";
  if (!element || element.nodeName.startsWith("#")) return { ok: false, error: stale };
  if (moves(element)) return { ok: false, error: "Этот текст двигает анимация — скажите словами" };
  const children = element.childNodes ?? [];
  const text = children[0];
  if (
    NOT_TEXT.has(element.nodeName) ||
    children.length !== 1 ||
    text?.nodeName !== "#text" ||
    !text.sourceCodeLocation
  ) {
    return { ok: false, error: "Здесь не просто текст — скажите словами через «Править»" };
  }
  if (squash(text.value ?? "") !== squash(edit.before)) return { ok: false, error: stale };
  const { startOffset, endOffset } = text.sourceCodeLocation;
  const source = html.slice(startOffset, endOffset);
  const lead = /^\s*/u.exec(source)![0];
  const trail = /\s*$/u.exec(source.slice(lead.length))![0];
  const next =
    html.slice(0, startOffset) + lead + escapeText(after) + trail + html.slice(endOffset);
  writeFileSync(path, next, "utf8");
  return { ok: true };
}
