/**
 * «Открыть превью» under a finished «Код» turn: the page it wrote or edited (`.html`), or a
 * local server the harness registry started. A server wins over a file, since it is what
 * serves the site; within a kind the latest one wins.
 */
import type { CodePreviewTarget } from "@zeno/contracts";
import { classifyToolName } from "./process-activity.ts";
import type { TimelineBlock, TimelineItem } from "./timeline.ts";

/**
 * The registry's own line (`describeProcess` in prsloy-harness), used where the tool result
 * has no structured `details`: a blocked server-like `bash` and a rewritten `cmd &`.
 */
const REGISTRY_LINE = /(?:^|\s)[\w.-]+: работает, pid \d+, порт (\d+)/mu;

function validPort(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535
    ? value
    : undefined;
}

export function previewTargetOfTool(item: TimelineItem): CodePreviewTarget | undefined {
  if (item.kind !== "tool" || item.status === "running") return undefined;
  const kind = classifyToolName(item.toolName);
  if (kind === "run") {
    const ports = (item.details as { ports?: unknown } | undefined)?.ports;
    const fromDetails = Array.isArray(ports) ? validPort(ports[0]) : undefined;
    const fromText = validPort(Number(REGISTRY_LINE.exec(item.output ?? "")?.[1]));
    const port = fromDetails ?? fromText;
    return port ? { kind: "server", port } : undefined;
  }
  if ((kind === "write" || kind === "edit") && item.status === "completed") {
    const args = item.args as { path?: unknown; file_path?: unknown } | undefined;
    const path = typeof args?.path === "string" ? args.path : args?.file_path;
    return typeof path === "string" && /\.html?$/iu.test(path.trim())
      ? { kind: "file", path: path.trim() }
      : undefined;
  }
  return undefined;
}

/** Preview target of each finished turn, keyed by the turn's last block (as the undo action). */
export function previewTargetsByBlock(
  blocks: readonly TimelineBlock[],
  running: boolean,
): Map<number, CodePreviewTarget> {
  const targets = new Map<number, CodePreviewTarget>();
  let turn: { last: number; file?: CodePreviewTarget; server?: CodePreviewTarget } | undefined;
  const flush = () => {
    const target = turn?.server ?? turn?.file;
    if (turn && target) targets.set(turn.last, target);
  };
  blocks.forEach((block, index) => {
    if (block.type === "item" && block.item.kind === "user") {
      flush();
      turn = { last: index };
      return;
    }
    if (!turn) return;
    turn.last = index;
    for (const item of block.type === "process" ? block.items : [block.item]) {
      const target = previewTargetOfTool(item);
      if (target?.kind === "server") turn.server = target;
      else if (target) turn.file = target;
    }
  });
  if (!running) flush();
  return targets;
}

export function previewTargetLabel(target: CodePreviewTarget): string {
  return target.kind === "server"
    ? `127.0.0.1:${target.port}`
    : (target.path.split(/[\\/]/u).pop() ?? target.path);
}
