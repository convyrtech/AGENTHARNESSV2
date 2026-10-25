/**
 * `run.py say` stdout → typed design events. The harness prints one JSON object per
 * line (see playbooks/site/harness/run.py); anything else (Python warnings, partial
 * lines) is dropped here, and every field is clamped before it crosses into the renderer.
 */
import type {
  DesignFile,
  DesignHarnessEvent,
  DesignOption,
  DesignOptionGroup,
} from "@zeno/contracts";

const MAX_TEXT = 4000;
const MAX_SHORT = 200;
const MAX_FILES = 12;
const MAX_OPTIONS = 8;
const MAX_GROUPS = 3;

/** Splits a byte stream into complete lines; keeps the tail until its newline arrives. */
export class LineSplitter {
  #tail = "";

  push(chunk: string): string[] {
    const text = this.#tail + chunk;
    const parts = text.split(/\r?\n/);
    this.#tail = parts.pop() ?? "";
    // A runaway line without newlines must not grow memory without bound.
    if (this.#tail.length > 1_000_000) this.#tail = "";
    return parts.filter((line) => line.trim() !== "");
  }

  flush(): string[] {
    const rest = this.#tail.trim();
    this.#tail = "";
    return rest ? [rest] : [];
  }
}

function str(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function option(item: unknown): DesignOption | undefined {
  if (!item || typeof item !== "object") return undefined;
  const rec = item as Record<string, unknown>;
  const key = str(rec.key, 8).trim();
  const label = str(rec.label, MAX_SHORT).trim();
  if (!key || !label) return undefined;
  if (rec.recommended !== true) return { key, label };
  // the card shows its own «рекомендую» badge: the agent's «(рекомендую)» would say it twice
  const bare = label
    .replace(/\s*(?:[([]\s*рекомендую\s*[)\]]|[—–,-]\s*рекомендую)\s*$/i, "")
    .trim();
  return { key, label: bare || label, recommended: true };
}

/**
 * Answer buttons grouped by question (`[{q, options}]`, at most 3 groups). A flat
 * `[{key, label}]` list from an older run.py becomes one group without a question.
 */
function optionGroups(value: unknown): DesignOptionGroup[] {
  if (!Array.isArray(value)) return [];
  const flat = value.some((v) => v && typeof v === "object" && "key" in v);
  const raw = flat ? [{ q: "", options: value }] : value;
  const out: DesignOptionGroup[] = [];
  for (const g of raw) {
    if (!g || typeof g !== "object") continue;
    const rec = g as Record<string, unknown>;
    const opts = (Array.isArray(rec.options) ? rec.options : [])
      .map(option)
      .filter((o): o is DesignOption => !!o)
      .slice(0, MAX_OPTIONS);
    if (opts.length) out.push({ q: str(rec.q, MAX_SHORT).trim(), options: opts });
    if (out.length >= MAX_GROUPS) break;
  }
  return out;
}

/**
 * Parse one stdout line. `toFile` maps an absolute path from the harness to a served
 * file, or undefined when the path is outside the workspace (then it is dropped).
 */
export function parseHarnessLine(
  line: string,
  toFile: (absPath: string) => DesignFile | undefined,
): DesignHarnessEvent | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const rec = raw as Record<string, unknown>;
  const t = typeof rec.t === "number" && Number.isFinite(rec.t) ? { t: rec.t } : {};
  switch (rec.ev) {
    case "stage":
      return {
        ev: "stage",
        gate: str(rec.gate, 8),
        title: str(rec.title, MAX_SHORT),
        model: str(rec.model, MAX_SHORT),
        attempt: typeof rec.attempt === "number" ? Math.max(1, Math.floor(rec.attempt)) : 1,
        ...t,
      };
    case "tool":
      return {
        ev: "tool",
        name: str(rec.name, 40),
        brief: str(rec.brief, MAX_SHORT),
        ...(typeof rec.doing === "string" && rec.doing.trim()
          ? { doing: str(rec.doing, MAX_SHORT).trim() }
          : {}),
        ...t,
      };
    case "note":
      return { ev: "note", text: str(rec.text, MAX_TEXT), ...t };
    case "owner": {
      const files: DesignFile[] = [];
      for (const f of Array.isArray(rec.files) ? rec.files : []) {
        if (typeof f !== "string") continue;
        const served = toFile(f);
        if (served && !files.some((x) => x.path === served.path)) files.push(served);
        if (files.length >= MAX_FILES) break;
      }
      return {
        ev: "owner",
        text: str(rec.text, MAX_TEXT),
        files,
        options: optionGroups(rec.options),
        ...t,
      };
    }
    case "done":
      return { ev: "done", text: str(rec.text, MAX_TEXT), ...t };
    case "stuck":
      return { ev: "stuck", text: str(rec.text, MAX_TEXT), ...t };
    default:
      return undefined;
  }
}

export function fileKind(path: string): DesignFile["kind"] {
  const ext = path.toLowerCase().split(".").pop() ?? "";
  if (["png", "jpg", "jpeg", "webp", "gif"].includes(ext)) return "image";
  if (["mp4", "webm"].includes(ext)) return "video";
  if (ext === "html") return "page";
  return "other";
}
