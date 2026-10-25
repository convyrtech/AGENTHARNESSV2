/** Baseline of temporary layout-lint exceptions (layout-baseline.json) and the report table. */
import type { LayoutRule, LayoutViolation } from "./layout-rules.ts";

export type BaselineEntry = {
  rule: LayoutRule;
  selector: string;
  /** Screen name, or "*" / absent for every screen. */
  screen?: string;
  reason: string;
  /** YYYY-MM-DD; from the next day on the entry no longer excuses anything. */
  until: string;
};

/** One violation at one point of the matrix. */
export type Finding = LayoutViolation & {
  screen: string;
  size: string;
  scale: number;
  theme: string;
  /** Screenshot with numbered frames, relative to the output folder, and this frame's number. */
  shot: string;
  n: number;
};

export function parseBaseline(json: unknown): BaselineEntry[] {
  const list = (json as { exceptions?: unknown })?.exceptions;
  if (!Array.isArray(list)) throw new Error("layout-baseline.json: «exceptions» must be an array");
  return list.map((entry, i) => {
    const e = entry as Partial<BaselineEntry>;
    if (!e.rule || !e.selector || !e.reason || !/^\d{4}-\d{2}-\d{2}$/.test(e.until ?? "")) {
      throw new Error(
        `layout-baseline.json #${i}: rule, selector, reason, until (YYYY-MM-DD) required`,
      );
    }
    return e as BaselineEntry;
  });
}

export function expired(entry: BaselineEntry, today: string): boolean {
  return entry.until < today;
}

/** The entry that excuses the finding, if any (expired entries excuse nothing). */
export function excuse(
  finding: Pick<Finding, "rule" | "selector" | "screen">,
  baseline: readonly BaselineEntry[],
  today: string,
): BaselineEntry | undefined {
  return baseline.find(
    (e) =>
      !expired(e, today) &&
      e.rule === finding.rule &&
      e.selector === finding.selector &&
      (!e.screen || e.screen === "*" || e.screen === finding.screen),
  );
}

export const RULE_TEXT: Record<LayoutRule, string> = {
  "root-hscroll": "горизонтальная прокрутка у корня",
  "off-window": "вылезает за окно",
  "text-clipped": "текст обрезан",
  overlap: "кнопки перекрываются",
  "target-size": "цель клика меньше 24×24",
  "small-text": "текст меньше 11 px",
  "focus-hidden": "фокус не виден",
  "window-min": "окно меньше минимального",
};

const pct = (scale: number) => `${Math.round(scale * 100)}%`;

/** Markdown table: one row per rule × screen × selector, with every matrix point it shows up at. */
export function reportTable(findings: readonly Finding[]): string {
  const groups = new Map<string, Finding[]>();
  for (const f of findings) {
    const key = `${f.rule}\u0000${f.screen}\u0000${f.selector}`;
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  const rows = [...groups.values()].sort(
    (a, b) =>
      a[0]!.rule.localeCompare(b[0]!.rule) ||
      a[0]!.screen.localeCompare(b[0]!.screen) ||
      b.length - a.length,
  );
  const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
  const lines = [
    "| # | Правило | Экран | Элемент | Текст | Где (окно@масштаб, тема) | Подробно | Скриншот |",
    "|---|---|---|---|---|---|---|---|",
  ];
  rows.forEach((group, i) => {
    const first = group[0]!;
    const where = [...new Set(group.map((f) => `${f.size}@${pct(f.scale)} ${f.theme}`))];
    lines.push(
      `| ${i + 1} | ${RULE_TEXT[first.rule]} | ${cell(first.screen)} | \`${cell(first.selector)}\` | ${cell(first.text)} | ${cell(where.length > 6 ? `${where.slice(0, 6).join(", ")} … ещё ${where.length - 6}` : where.join(", "))} | ${cell(first.detail)} | ${first.shot} №${first.n} |`,
    );
  });
  return `${lines.join("\n")}\n`;
}
