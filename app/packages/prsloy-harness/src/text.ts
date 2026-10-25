import type { ExtensionAPI, ToolResultEvent } from "@earendil-works/pi-coding-agent";

export type ResultContent = ToolResultEvent["content"];
type ContentPart = ResultContent[number];
type TextPart = Extract<ContentPart, { type: "text" }>;

export function contentText(content: ResultContent | undefined): string {
  if (!content) return "";
  return content
    .filter((part): part is TextPart => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

/** Заменяет все текстовые части одной, картинки сохраняет. */
export function withText(content: ResultContent | undefined, text: string): ResultContent {
  const images = (content ?? []).filter((part) => part.type !== "text");
  return [{ type: "text", text }, ...images];
}

export function appendText(content: ResultContent | undefined, note: string): ResultContent {
  const text = contentText(content);
  return withText(content, text ? `${text}\n\n${note}` : note);
}

/** JSON с отсортированными ключами: одинаковые аргументы дают одинаковую строку. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

export function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1).replace(".", ",")} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace(".", ",")} МБ`;
}

export function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1).replace(".", ",")} с`;
}

/** Первые `bytes` байт по границе строки (UTF-8 безопасно). */
export function headBytes(text: string, bytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= bytes) return text;
  let cut = buf.subarray(0, bytes).toString("utf8");
  if (cut.endsWith("\uFFFD")) cut = cut.slice(0, -1);
  const nl = cut.lastIndexOf("\n");
  return nl > bytes / 2 ? cut.slice(0, nl) : cut;
}

/** Последние `bytes` байт по границе строки. */
export function tailBytes(text: string, bytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= bytes) return text;
  let cut = buf.subarray(buf.length - bytes).toString("utf8");
  if (cut.startsWith("\uFFFD")) cut = cut.slice(1);
  const nl = cut.indexOf("\n");
  return nl >= 0 && nl < bytes / 2 ? cut.slice(nl + 1) : cut;
}

/** Начало и конец текста, общий размер не больше `limit` байт. */
/**
 * Карточка для человека в чате. Не записью границы хода: те Pi пишет в сессию без события message_end, и
 * приложение их не показывает. sendMessage без нового хода во время хода Pi откладывает и добавляет сразу
 * после записей границы — с обычными событиями сообщения.
 */
export async function showCard(
  pi: Pick<ExtensionAPI, "sendMessage">,
  customType: string,
  content: string,
  details?: unknown,
): Promise<void> {
  try {
    // Pi кладёт сообщение в очередь синхронно; промис (если он есть) ждём только ради ошибок.
    await Promise.resolve(
      pi.sendMessage(
        { customType, content, display: true, ...(details === undefined ? {} : { details }) },
        { triggerTurn: false },
      ),
    );
  } catch {
    // карточка — не повод ронять ход
  }
}

export function headTail(text: string, limit: number, headShare = 0.35): string {
  if (byteLength(text) <= limit) return text;
  const head = headBytes(text, Math.floor(limit * headShare));
  const tail = tailBytes(text, Math.floor(limit * (1 - headShare)));
  const omitted = byteLength(text) - byteLength(head) - byteLength(tail);
  return `${head}\n\n… [пропущено ${formatBytes(Math.max(0, omitted))}] …\n\n${tail}`;
}

export function countLines(text: string): number {
  if (!text) return 0;
  return text.split("\n").length;
}

/**
 * Pi удаляет structuredContent, если обработчик заменил content и не вернул его (runner.emitToolResult).
 * Кто дописывает строку в текст, должен вернуть structuredContent как был — иначе codemode его потеряет.
 */
export function keepStructured<T extends { structuredContent?: unknown }>(
  event: T,
): Pick<T, "structuredContent"> | Record<string, never> {
  return event.structuredContent === undefined
    ? {}
    : { structuredContent: event.structuredContent };
}
