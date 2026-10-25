// Практика 6 (PLAN-alpha §3): вывод тулов — лимит, файл и превью, начало и конец при ошибке, заголовок.
// Источник: ADR-5 (research/00-synthesis.md; research/02-claude-code-anthropic.md, 03-codex-openai.md).
// Pi уже режет bash до последних 2000 строк / 50 КБ и сохраняет полный вывод во временный файл,
// read — до первых 2000 строк / 50 КБ. Здесь только недостающее: 30 КБ, начало+конец, заголовок.
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import type { ResolvedOptions } from "./options.ts";
import {
  byteLength,
  contentText,
  formatBytes,
  formatSeconds,
  headBytes,
  headTail,
  withText,
  keepStructured,
} from "./text.ts";

const SHELL_TOOLS = new Set(["bash", "powershell"]);
/** Тулы, у которых свой формат результата: правки файлов. */
const SKIP_TOOLS = new Set(["edit", "write"]);
const PI_TRUNCATION =
  /\n\n\[Showing (?:last [^\]]*? of line \d+|lines \d+-\d+ of \d+)[^\]]*?Full output: ([^\]\n]+)\]/;
const EXIT_LINE = /Command exited with code (\d+)/;

interface ShellStructured {
  output?: string;
  exit_code?: number;
  wall_time_seconds?: number;
  full_output_path?: string;
}

function readIfExists(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function sizeOf(path: string): number | undefined {
  try {
    return statSync(path).size;
  } catch {
    return undefined;
  }
}

export function installToolOutput(pi: ExtensionAPI, opts: ResolvedOptions): void {
  const startedAt = new Map<string, number>();
  const spillDir = join(opts.outputDir, `out-${process.pid}-${Date.now().toString(36)}`);

  const spill = (toolCallId: string, text: string): string => {
    mkdirSync(spillDir, { recursive: true });
    const path = join(spillDir, `${toolCallId.replace(/[^\w.-]+/g, "_")}.txt`);
    writeFileSync(path, text);
    return path;
  };

  pi.on("before_agent_start", () => {
    startedAt.clear();
  });

  pi.on("tool_call", (event) => {
    startedAt.set(event.toolCallId, Date.now());
    return undefined;
  });

  pi.on("tool_result", (event) => {
    const started = startedAt.get(event.toolCallId);
    startedAt.delete(event.toolCallId);
    if (SKIP_TOOLS.has(event.toolName)) return undefined;
    const elapsedMs = started === undefined ? undefined : Date.now() - started;
    if (SHELL_TOOLS.has(event.toolName)) return shellResult(event, elapsedMs);
    if (event.toolName === "read") return readResult(event);
    return genericResult(event);
  });

  function shellResult(event: ToolResultEvent, elapsedMs: number | undefined) {
    const text = contentText(event.content);
    const structured = (event.structuredContent ?? undefined) as ShellStructured | undefined;
    const details = event.details as { fullOutputPath?: string } | undefined;
    const piCut = PI_TRUNCATION.exec(text);
    const fullPath = details?.fullOutputPath ?? structured?.full_output_path ?? piCut?.[1]?.trim();

    let body = text;
    let status = "";
    if (piCut) {
      body = text.slice(0, piCut.index);
      status = text.slice(piCut.index + piCut[0].length).trim();
    }
    const full = fullPath ? readIfExists(fullPath) : undefined;
    const originalBytes =
      (fullPath ? sizeOf(fullPath) : undefined) ?? byteLength(structured?.output ?? body);

    let cut = false;
    let spillPath = fullPath;
    if (full !== undefined && byteLength(full) > opts.inlineLimitBytes) {
      // Pi оставил только хвост; при ошибке причина часто в начале — показываем оба конца.
      body = headTail(full, opts.inlineLimitBytes);
      cut = true;
    } else if (full !== undefined && piCut) {
      body = full;
    } else if (byteLength(body) > opts.inlineLimitBytes) {
      const source =
        structured?.output && byteLength(structured.output) > byteLength(body)
          ? structured.output
          : body;
      spillPath = spill(event.toolCallId, source);
      body = headTail(source, opts.inlineLimitBytes);
      cut = true;
    }

    const exit =
      structured?.exit_code ??
      (EXIT_LINE.exec(text)?.[1] !== undefined ? Number(EXIT_LINE.exec(text)?.[1]) : undefined) ??
      (event.isError ? undefined : 0);
    const exitLabel =
      exit !== undefined ? `exit ${exit}` : /таймаут|timed out/i.test(text) ? "таймаут" : "ошибка";
    const seconds =
      elapsedMs !== undefined
        ? formatSeconds(elapsedMs)
        : structured?.wall_time_seconds !== undefined
          ? formatSeconds(structured.wall_time_seconds * 1000)
          : undefined;
    const parts = [exitLabel, seconds, formatBytes(originalBytes)].filter(Boolean);
    const header = `[${parts.join(" · ")}${cut && spillPath ? ` · показаны начало и конец, полностью: ${spillPath}` : ""}]`;
    const finalText = [header, body.trimEnd(), status]
      .filter((piece) => piece.length > 0)
      .join("\n");
    return {
      content: withText(event.content, finalText),
      ...keepStructured(event),
    };
  }

  function readResult(event: ToolResultEvent) {
    const text = contentText(event.content);
    if (byteLength(text) <= opts.inlineLimitBytes) return undefined;
    const kept = headBytes(text, opts.inlineLimitBytes);
    const keptLines = kept.split("\n").length;
    const input = event.input as { offset?: unknown };
    const from = typeof input.offset === "number" && input.offset > 0 ? input.offset : 1;
    const note = `[Показаны строки ${from}–${from + keptLines - 1} (лимит ${formatBytes(opts.inlineLimitBytes)}). Дальше: read с offset=${from + keptLines}.]`;
    return {
      content: withText(event.content, `${kept}\n\n${note}`),
      ...keepStructured(event),
    };
  }

  function genericResult(event: ToolResultEvent) {
    const text = contentText(event.content);
    const size = byteLength(text);
    if (size <= opts.inlineLimitBytes) return undefined;
    const path = spill(event.toolCallId, text);
    const header = `[${event.isError ? "ошибка · " : ""}${formatBytes(size)} · показаны начало и конец, полностью: ${path}]`;
    return {
      content: withText(event.content, `${header}\n${headTail(text, opts.inlineLimitBytes)}`),
      ...keepStructured(event),
    };
  }
}
