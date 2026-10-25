// Практика ADR-4 (research/00-synthesis.md): «2 провала → переписать файл целиком», сохранение BOM/CRLF.
// Pi 1.4 edit уже сохраняет BOM и концы строк (tools/edit.js), write — нет: дописываем это для write
// поверх существующего файла.
import { readFile } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ResolvedOptions } from "./options.ts";
import { resolvePath } from "./post-edit-verify.ts";
import { appendText, keepStructured } from "./text.ts";

/** Для больших файлов переписывать целиком опасно (research/opinion-deepseek-v4.1-flash-1017.md, ADR-4). */
export const LARGE_FILE_LINES = 500;

export const EDIT_RETRY_NOTE_LARGE =
  "Правка в этом файле не совпала уже 2 раза подряд. Файл большой — целиком не переписывай: перечитай нужный кусок (read с offset и limit) и возьми oldText дословно оттуда, с запасом в пару строк.";

export const EDIT_RETRY_NOTE =
  "Правка в этом файле не совпала уже 2 раза подряд. Не угадывай текст: перечитай файл (read) и возьми oldText дословно из него, или перепиши файл целиком через write.";

/** Приводит новое содержимое к BOM и концам строк старого файла. */
export function preserveFormat(previous: string, next: string): string {
  let out = next;
  const hadBom = previous.startsWith("\uFEFF");
  if (hadBom && !out.startsWith("\uFEFF")) out = `\uFEFF${out}`;
  // Как detectLineEnding в Pi: решает первая строка файла.
  const firstLf = previous.indexOf("\n");
  const wasCrlf = firstLf > 0 && previous[firstLf - 1] === "\r";
  if (wasCrlf && !out.includes("\r\n")) out = out.replace(/\n/g, "\r\n");
  return out;
}

export function installEditRobustness(pi: ExtensionAPI, _opts: ResolvedOptions): void {
  let failures = new Map<string, number>();

  pi.on("before_agent_start", (event) => {
    if (event.messageType === "user") failures = new Map();
  });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "write") return undefined;
    const input = event.input as { path?: unknown; content?: unknown };
    if (typeof input.path !== "string" || typeof input.content !== "string") return undefined;
    try {
      const previous = await readFile(resolvePath(ctx.cwd, input.path), "utf8");
      input.content = preserveFormat(previous, input.content);
    } catch {
      // новый файл
    }
    return undefined;
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "edit" || typeof event.input.path !== "string") return undefined;
    const key = resolvePath(ctx.cwd, event.input.path);
    if (!event.isError) {
      failures.delete(key);
      return undefined;
    }
    const count = (failures.get(key) ?? 0) + 1;
    failures.set(key, count);
    if (count < 2) return undefined;
    const lines = await readFile(key, "utf8").then(
      (text) => text.split("\n").length,
      () => 0,
    );
    const note = lines > LARGE_FILE_LINES ? EDIT_RETRY_NOTE_LARGE : EDIT_RETRY_NOTE;
    return { content: appendText(event.content, note), ...keepStructured(event) };
  });
}
