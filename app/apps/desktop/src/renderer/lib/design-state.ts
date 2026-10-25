/**
 * «Дизайн» tab state: folds harness events (see @zeno/contracts design.ts) into the
 * stream the owner sees — owner cards, his own messages, one progress line, a quiet
 * activity ticker — and what the composer may do next.
 */
import type { DesignEvent, DesignFile, DesignOptionGroup } from "@zeno/contracts";
import type { MessageKey } from "./i18n.ts";

/**
 * The pipeline's eleven gates as eight steps an owner can follow
 * (design-pipeline/tools/flow.py ORDER).
 */
export const DESIGN_STEPS: readonly { gates: readonly string[]; key: MessageKey }[] = [
  { gates: ["0", "0a", "1"], key: "design.step.start" },
  { gates: ["2"], key: "design.step.brand" },
  { gates: ["2a"], key: "design.step.meaning" },
  { gates: ["3"], key: "design.step.refs" },
  { gates: ["4"], key: "design.step.motion" },
  { gates: ["5"], key: "design.step.prototypes" },
  { gates: ["6", "7"], key: "design.step.build" },
  { gates: ["8"], key: "design.step.publish" },
];

export function stepOf(
  gate: string,
): { index: number; total: number; key: MessageKey } | undefined {
  const i = DESIGN_STEPS.findIndex((s) => s.gates.includes(gate));
  const step = DESIGN_STEPS[i];
  return step ? { index: i + 1, total: DESIGN_STEPS.length, key: step.key } : undefined;
}

export type DesignItem =
  | { kind: "user"; id: number; text: string; files: string[] }
  | {
      kind: "owner";
      id: number;
      text: string;
      files: DesignFile[];
      options: DesignOptionGroup[];
      answered: boolean;
    }
  | { kind: "stuck"; id: number; detail: string }
  | { kind: "done"; id: number }
  | { kind: "error"; id: number; detail: string }
  | { kind: "cancelled"; id: number }
  /** The turn used its stage budget without a question: the owner continues it. */
  | { kind: "paused"; id: number };

export type DesignStage = { gate: string; title: string; attempt: number; since: number };

export type DesignView = {
  items: DesignItem[];
  running: boolean;
  stage: DesignStage | undefined;
  /** Last few tool calls of the current stage, newest last. */
  ticker: string[];
  /** The current run already produced owner/done/stuck. */
  answered: boolean;
  nextId: number;
};

export const EMPTY_DESIGN_VIEW: DesignView = {
  items: [],
  running: false,
  stage: undefined,
  ticker: [],
  answered: false,
  nextId: 1,
};

const TICKER = 3;

type NewItem = DesignItem extends infer I ? (I extends DesignItem ? Omit<I, "id"> : never) : never;

function push(view: DesignView, item: NewItem): DesignView {
  return {
    ...view,
    items: [...view.items, { ...item, id: view.nextId } as DesignItem],
    nextId: view.nextId + 1,
  };
}

/** One tool call as a short line: the command or path, never the JSON. */
export function tickerLine(name: string, brief: string): string {
  let text = brief.trim();
  if (text.startsWith("{")) {
    try {
      const args = JSON.parse(text) as Record<string, unknown>;
      const value = args.path ?? args.command ?? args.file;
      text = typeof value === "string" ? value : "";
    } catch {
      // truncated JSON from the harness (120 chars): keep what is readable
      text = /"(?:path|command)":\s*"([^"]+)/.exec(text)?.[1] ?? "";
    }
  }
  text = text.replace(/^python3?\s+-I\s+/, "").replace(/design-pipeline\/tools\//, "");
  return text ? `${name} ${text}`.slice(0, 120) : name;
}

export function reduceDesign(view: DesignView, event: DesignEvent, now = Date.now()): DesignView {
  switch (event.ev) {
    case "user": {
      const items = view.items.map((it) =>
        it.kind === "owner" && !it.answered ? { ...it, answered: true } : it,
      );
      return push(
        { ...view, items, running: true, answered: false, ticker: [] },
        { kind: "user", text: event.text, files: event.files },
      );
    }
    case "stage":
      return {
        ...view,
        running: true,
        stage: { gate: event.gate, title: event.title, attempt: event.attempt, since: now },
        ticker: [],
      };
    case "tool":
      return {
        ...view,
        ticker: [...view.ticker, tickerLine(event.name, event.brief)].slice(-TICKER),
      };
    case "note":
      return { ...view, ticker: [...view.ticker, event.text.split("\n")[0] ?? ""].slice(-TICKER) };
    case "owner":
      return push(
        { ...view, answered: true },
        {
          kind: "owner",
          text: event.text,
          files: event.files,
          options: event.options,
          answered: false,
        },
      );
    case "done":
      return push({ ...view, answered: true }, { kind: "done" });
    case "stuck":
      return push({ ...view, answered: true }, { kind: "stuck", detail: event.text });
    case "exit": {
      const base: DesignView = { ...view, running: false, stage: undefined, ticker: [] };
      if (event.cancelled) return push(base, { kind: "cancelled" });
      if (event.error) return push(base, { kind: "error", detail: event.error });
      if (!view.answered) return push(base, { kind: "paused" });
      return base;
    }
    default:
      return view;
  }
}

export function foldDesign(events: DesignEvent[], running: boolean): DesignView {
  const view = events.reduce((v, e) => reduceDesign(v, e, (e.t ?? 0) * 1000), EMPTY_DESIGN_VIEW);
  // A run that ended while the tab was closed left no exit event behind.
  return running ? { ...view, running: true } : { ...view, running: false, stage: undefined };
}

/** The latest owner card still waiting for an answer (its buttons are live). */
export function openQuestion(view: DesignView): Extract<DesignItem, { kind: "owner" }> | undefined {
  if (view.running) return undefined;
  const last = view.items.at(-1);
  return last?.kind === "owner" && !last.answered ? last : undefined;
}

/** What the last item lets the owner do besides typing. */
export function lastItemKind(view: DesignView): DesignItem["kind"] | undefined {
  return view.items.at(-1)?.kind;
}

export function elapsedMinutes(stage: DesignStage | undefined, now = Date.now()): number {
  return stage ? Math.max(0, Math.floor((now - stage.since) / 60_000)) : 0;
}

const OPTION_LINE = /^\s*(?:\d[.)]\s*)?[A-DА-Г][.)]\s+\S/;
const QUESTION_LINE = /^\s*\d+[.)]\s+(.+\?)\s*$/;

/**
 * Owner text as shown on the card: option lines become buttons, question lines become
 * the button rows' captions, picture paths become pictures — none is repeated.
 */
export function ownerText(text: string, files: DesignFile[], groups: DesignOptionGroup[]): string {
  let out = text;
  for (const f of files) {
    out = out.replaceAll(f.path, "").replaceAll(f.path.split("/").pop() ?? f.path, "");
  }
  const asked = new Set(groups.map((g) => g.q).filter(Boolean));
  const hasOptions = groups.some((g) => g.options.length > 0);
  const lines = out.split("\n").filter((ln) => {
    if (hasOptions && OPTION_LINE.test(ln)) return false;
    const q = QUESTION_LINE.exec(ln)?.[1]?.trim();
    return !(q && asked.has(q));
  });
  return lines
    .map((ln) => ln.replace(/\s*[:—-]\s*$/, (m) => (m.includes(":") ? "." : "")).trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The engine's «как рекомендуешь»: closes every open choice with the agent's recommendation. */
export const RECOMMEND_ANSWER = "как рекомендуешь";

/**
 * Owner's answer to a card. One question → the picked letter with its label; several →
 * "1А 2Б 3А" (run.py reads both). Undefined until every question has a pick.
 */
export function answerText(
  groups: DesignOptionGroup[],
  picks: Readonly<Record<number, string>>,
): string | undefined {
  if (groups.length === 0 || groups.some((_, i) => !picks[i])) return undefined;
  if (groups.length === 1) {
    const key = picks[0]!;
    const label = groups[0]!.options.find((o) => o.key === key)?.label;
    return label ? `${key}. ${label}` : key;
  }
  return groups.map((_, i) => `${i + 1}${picks[i]}`).join(" ");
}
