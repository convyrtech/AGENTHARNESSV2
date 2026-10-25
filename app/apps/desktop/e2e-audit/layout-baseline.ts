/** Baseline of temporary layout-lint exceptions (layout-baseline.json) and the report table. */
import type { LayoutRule, LayoutViolation } from "@zeno/layout-rules";

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

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
const short = (items: string[], n: number) =>
  items.length > n ? `${items.slice(0, n).join(", ")} … ещё ${items.length - n}` : items.join(", ");

function byElement(findings: readonly Finding[]): Finding[][] {
  const groups = new Map<string, Finding[]>();
  for (const f of findings) {
    const key = `${f.rule}\u0000${f.selector}`;
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  return [...groups.values()].sort(
    (a, b) => a[0]!.rule.localeCompare(b[0]!.rule) || b.length - a.length,
  );
}

/** Per rule: how many distinct elements, on how many screens, at how many matrix points. */
export function summaryTable(findings: readonly Finding[]): string {
  const lines = [
    "| Правило | Элементов (уникальных селекторов) | Экранов | Нарушений по матрице |",
    "|---|---|---|---|",
  ];
  for (const [rule, text] of Object.entries(RULE_TEXT)) {
    const of = findings.filter((f) => f.rule === rule);
    if (of.length === 0) continue;
    const selectors = new Set(of.map((f) => f.selector)).size;
    const screens = new Set(of.map((f) => f.screen)).size;
    lines.push(`| ${text} | ${selectors} | ${screens} | ${of.length} |`);
  }
  return `${lines.join("\n")}\n`;
}

/** Markdown table: one row per rule × element, with its screens and matrix points. */
export function reportTable(findings: readonly Finding[]): string {
  const lines = [
    "| # | Правило | Элемент | Текст | Экраны | Где (окно@масштаб, тема) | Подробно | Скриншот |",
    "|---|---|---|---|---|---|---|---|",
  ];
  byElement(findings).forEach((group, i) => {
    const first = group[0]!;
    const screens = [...new Set(group.map((f) => f.screen))];
    const where = [...new Set(group.map((f) => `${f.size}@${pct(f.scale)} ${f.theme}`))];
    lines.push(
      `| ${i + 1} | ${RULE_TEXT[first.rule]} | \`${cell(first.selector)}\` | ${cell(first.text)} | ${cell(short(screens, 5))} | ${cell(short(where, 6))} | ${cell(first.detail)} | ${first.shot} №${first.n} |`,
    );
  });
  return `${lines.join("\n")}\n`;
}
