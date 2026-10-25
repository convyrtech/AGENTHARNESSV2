/**
 * Where a picked element is written: every element of the served HTML file gets
 * `data-pl="<file>:<line>:<col>"` from parse5's source locations, so «Выбрать на странице»
 * names the exact place in a static page. Only in the response of the «Код» preview
 * server; the file on disk is never touched. Elements a script creates have no mark: the
 * inspector climbs to the nearest marked parent (research 20 §1, step 2).
 */
import { parse } from "parse5";

export const SOURCE_ATTR = "data-pl";

const NOT_MARKED = new Set(["script", "style"]);

type Node = {
  nodeName: string;
  childNodes?: Node[];
  content?: Node;
  sourceCodeLocation?: { startTag?: { startLine: number; startCol: number; endOffset: number } };
};

function escapeAttr(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/"/gu, "&quot;").replace(/</gu, "&lt;");
}

/** The page with every written element marked; on a parse failure, the page as is. */
export function tagSource(html: string, file: string): string {
  let document: Node;
  try {
    document = parse(html, { sourceCodeLocationInfo: true }) as unknown as Node;
  } catch {
    return html;
  }
  const inserts: { at: number; text: string }[] = [];
  const name = escapeAttr(file);
  const walk = (node: Node) => {
    const start = node.sourceCodeLocation?.startTag;
    // Not <script>/<style>: nobody picks them, and a mark there would shift the columns of
    // the errors an inline script reports (page-errors.js).
    if (start && !node.nodeName.startsWith("#") && !NOT_MARKED.has(node.nodeName)) {
      // Before `>` (or `/>`): the attribute joins the tag the author wrote.
      let at = start.endOffset - 1;
      if (html[at - 1] === "/") at -= 1;
      if (html[at] === ">" || html[at] === "/") {
        inserts.push({
          at,
          text: ` ${SOURCE_ATTR}="${name}:${start.startLine}:${start.startCol}"`,
        });
      }
    }
    for (const child of node.childNodes ?? []) walk(child);
    if (node.content) walk(node.content);
  };
  walk(document);
  inserts.sort((a, b) => b.at - a.at);
  let out = html;
  for (const insert of inserts) out = out.slice(0, insert.at) + insert.text + out.slice(insert.at);
  return out;
}

/** Text of a served file: UTF-8 when it is valid UTF-8, else byte for byte (latin1). */
export function decodePage(bytes: Buffer): { text: string; encoding: "utf8" | "latin1" } {
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), encoding: "utf8" };
  } catch {
    return { text: bytes.toString("latin1"), encoding: "latin1" };
  }
}
