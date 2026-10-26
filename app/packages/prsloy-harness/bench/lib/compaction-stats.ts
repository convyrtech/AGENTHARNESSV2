// Перезапускает ли агент работу после сжатия контекста: счёт по записям сессии Pi. Чистая функция, без I/O.

export interface CompactionStats {
  /** Записей с type "compaction". */
  compactions: number;
  /** Вызовов инструментов до первого сжатия. */
  callsBefore: number;
  /** Вызовов инструментов после первого сжатия (0, если сжатия не было). */
  callsAfter: number;
  /** `read` после сжатия того же `path`, что читали до него. */
  rereadAfter: number;
  /** `bash` после сжатия с той же `command`, что запускали до него. */
  rerunAfter: number;
  /** После сжатия читал AGENTS.md / CLAUDE.md / README.md (или упоминал их в bash). */
  docsAfter: boolean;
  /** Есть запись custom "prsloy-harness.task-thread". */
  thread: boolean;
}

const THREAD_TYPE = "prsloy-harness.task-thread";
const DOC_NAMES = ["agents.md", "claude.md", "readme.md"];

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const baseName = (path: string) => {
  const parts = path.split(/[\\/]/);
  return (parts[parts.length - 1] ?? "").toLowerCase();
};

interface Call {
  name: string;
  args: Record<string, unknown>;
}

function callsOf(entry: Record<string, unknown>): Call[] {
  const m = entry.message;
  if (!isObject(m) || m.role !== "assistant" || !Array.isArray(m.content)) return [];
  const out: Call[] = [];
  for (const p of m.content) {
    if (!isObject(p) || p.type !== "toolCall" || typeof p.name !== "string") continue;
    out.push({ name: p.name, args: isObject(p.arguments) ? p.arguments : {} });
  }
  return out;
}

export function compactionStats(entries: readonly unknown[]): CompactionStats {
  const s: CompactionStats = {
    compactions: 0,
    callsBefore: 0,
    callsAfter: 0,
    rereadAfter: 0,
    rerunAfter: 0,
    docsAfter: false,
    thread: false,
  };
  const readBefore = new Set<string>();
  const ranBefore = new Set<string>();
  let after = false;
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!isObject(entry)) continue;
    if (entry.type === "compaction") {
      s.compactions += 1;
      after = true;
      continue;
    }
    if (entry.type === "custom" && entry.customType === THREAD_TYPE) {
      s.thread = true;
      continue;
    }
    if (entry.type !== "message") continue;
    for (const { name, args } of callsOf(entry)) {
      const path = name === "read" && typeof args.path === "string" ? args.path : undefined;
      const command =
        name === "bash" && typeof args.command === "string" ? args.command : undefined;
      if (!after) {
        s.callsBefore += 1;
        if (path !== undefined) readBefore.add(path);
        if (command !== undefined) ranBefore.add(command);
        continue;
      }
      s.callsAfter += 1;
      if (path !== undefined) {
        if (readBefore.has(path)) s.rereadAfter += 1;
        if (DOC_NAMES.includes(baseName(path))) s.docsAfter = true;
      }
      if (command !== undefined) {
        if (ranBefore.has(command)) s.rerunAfter += 1;
        const lower = command.toLowerCase();
        if (DOC_NAMES.some((d) => lower.includes(d))) s.docsAfter = true;
      }
    }
  }
  return s;
}
