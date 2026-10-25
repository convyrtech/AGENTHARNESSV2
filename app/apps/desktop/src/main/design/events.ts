/**
 * `run.py say` stdout → typed design events. The harness prints one JSON object per
 * line (see playbooks/site/harness/run.py); anything else (Python warnings, partial
 * lines) is dropped here, and every field is clamped before it crosses into the renderer.
 */
import type { DesignFile, DesignHarnessEvent, DesignOption } from "@zeno/contracts";

const MAX_TEXT = 4000;
const MAX_SHORT = 200;
const MAX_FILES = 12;
const MAX_OPTIONS = 8;

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

function options(value: unknown): DesignOption[] {
  if (!Array.isArray(value)) return [];
  const out: DesignOption[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const key = str(rec.key, 8).trim();
    const label = str(rec.label, MAX_SHORT).trim();
    if (key && label) out.push({ key, label });
    if (out.length >= MAX_OPTIONS) break;
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
      return { ev: "tool", name: str(rec.name, 40), brief: str(rec.brief, MAX_SHORT), ...t };
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
        options: options(rec.options),
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
