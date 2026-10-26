// NVIDIA SkillSpector (Apache-2.0) как внешний сканер навыков: статический режим `--no-llm` (regex, AST, taint,
// YARA), оценка 0–100, выше 50 — «не ставить». В приложение не входит: его ставят CI и машина тюнера
// (`uv tool install --python 3.12 git+https://github.com/NVIDIA/skillspector.git@<коммит>`). Нет сканера —
// работает только своя проверка (skill-threats.ts).
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Порог SkillSpector: выше — риск (их exit 1). */
export const SCORE_LIMIT = 50;

export interface SpectorResult {
  score?: number;
  severity?: string;
  /** До пяти находок строками: «HIGH заголовок (место)». */
  issues: string[];
  error?: string;
}

/** Путь к сканеру: SKILLSPECTOR или `skillspector` в PATH; undefined — не установлен. */
export function skillspectorBin(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const bin = env.SKILLSPECTOR ?? "skillspector";
  const r = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 30_000 });
  return r.error || r.status !== 0 ? undefined : bin;
}

const str = (v: unknown): string =>
  typeof v === "string" || typeof v === "number" ? String(v) : v ? JSON.stringify(v) : "";

/** Один навык (папка) через SkillSpector `scan --no-llm --format json`. */
export function skillspectorScan(path: string, bin: string): SpectorResult {
  const tmp = mkdtempSync(join(tmpdir(), "skill-scan-"));
  const out = join(tmp, "report.json");
  try {
    const r = spawnSync(bin, ["scan", path, "--no-llm", "--format", "json", "--output", out], {
      encoding: "utf8",
      timeout: 300_000,
    });
    if (r.error) return { issues: [], error: `не запустился: ${r.error.message}` };
    // 0 — чисто, 1 — риск выше порога; прочее — сбой сканера.
    if (r.status !== 0 && r.status !== 1)
      return {
        issues: [],
        error: `код ${r.status}: ${(r.stderr || r.stdout).trim().split("\n").slice(-1)[0]}`,
      };
    const report = JSON.parse(readFileSync(out, "utf8")) as {
      risk_assessment?: { score?: number; severity?: string };
      issues?: Record<string, unknown>[];
    };
    // Поля находки в их JSON разные по версиям: строка, число или объект (location) — в строку.
    const issues = (report.issues ?? []).slice(0, 5).map((i) => {
      const what = str(i.title ?? i.rule_id ?? i.id ?? i.category) || "?";
      const where = str(i.file ?? i.location);
      return `${str(i.severity).toUpperCase()} ${what}${where ? ` (${where})` : ""}`.trim();
    });
    return {
      ...(report.risk_assessment?.score !== undefined
        ? { score: report.risk_assessment.score }
        : {}),
      ...(report.risk_assessment?.severity ? { severity: report.risk_assessment.severity } : {}),
      issues,
    };
  } catch (e) {
    return { issues: [], error: `отчёт не разобран: ${(e as Error).message}` };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
