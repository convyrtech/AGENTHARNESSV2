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
  | { kind: "paused"; id: number }
  /** The app closed in the middle of a turn: no exit came back; the owner continues it. */
  | { kind: "interrupted"; id: number };

export type DesignStage = {
  gate: string;
  title: string;
  attempt: number;
  since: number;
  /** When this turn entered the step: a gate retried or the next gate of the same step keeps it. */
  stepSince: number;
};

export type DesignView = {
  items: DesignItem[];
  running: boolean;
  stage: DesignStage | undefined;
  /** Last tool calls of the current stage, newest last (shown under «Подробности»). */
  ticker: string[];
  /** The harness's own words for what it is doing now (`tool.doing`), when it sends them. */
  doing?: string | undefined;
  /** Harness clock of the latest event, ms: a long gap reads as «Думаю над шагом…». */
  lastEventAt?: number | undefined;
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

const TICKER = 8;

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
  // «cd <workspace> && …» opens almost every command: the part after it is what was run.
  text = text.replace(/^cd\s+\S+\s*&&\s*/, "");
  text = text.replace(/^python3?\s+-I\s+/, "").replace(/design-pipeline\/tools\//, "");
  return text ? `${name} ${text}`.slice(0, 120) : name;
}

/** An event time this far behind its arrival is a stale clock or an old log, not «now». */
const STALE_EVENT_MS = 10 * 60_000;

/**
 * Events carry the harness's clock (`t`, seconds) and times shown (minutes in the step, time
 * left, silence) are measured on it. Without `t`, or with a `t` long before the event arrived
 * (a clock far off, a replayed old log), the arrival time stands in. A clock running ahead is
 * kept: a sped-up replay shows the recording's real durations.
 */
function eventTime(event: DesignEvent, now: number): number {
  const t = typeof event.t === "number" && Number.isFinite(event.t) ? event.t * 1000 : undefined;
  return t !== undefined && t >= now - STALE_EVENT_MS ? t : now;
}

export function reduceDesign(view: DesignView, event: DesignEvent, now = Date.now()): DesignView {
  const at = eventTime(event, now);
  switch (event.ev) {
    case "user": {
      const items = view.items.map((it) =>
        it.kind === "owner" && !it.answered ? { ...it, answered: true } : it,
      );
      return push(
        {
          ...view,
          items,
          running: true,
          answered: false,
          ticker: [],
          doing: undefined,
          lastEventAt: at,
        },
        { kind: "user", text: event.text, files: event.files },
      );
    }
    case "stage": {
      const sameStep =
        view.stage !== undefined && stepOf(view.stage.gate)?.index === stepOf(event.gate)?.index;
      return {
        ...view,
        running: true,
        stage: {
          gate: event.gate,
          title: event.title,
          attempt: event.attempt,
          since: at,
          stepSince: sameStep && view.stage ? view.stage.stepSince : at,
        },
        ticker: [],
        doing: undefined,
        lastEventAt: at,
      };
    }
    case "tool":
      return {
        ...view,
        ticker: [...view.ticker, tickerLine(event.name, event.brief)].slice(-TICKER),
        doing: event.doing?.trim() || view.doing,
        lastEventAt: at,
      };
    case "note":
      return {
        ...view,
        ticker: [...view.ticker, event.text.split("\n")[0] ?? ""].slice(-TICKER),
        lastEventAt: at,
      };
    case "owner":
      return push(
        { ...view, answered: true, lastEventAt: at },
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
      const base: DesignView = {
        ...view,
        running: false,
        stage: undefined,
        ticker: [],
        doing: undefined,
      };
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
  if (running) return { ...view, running: true };
  const ended = { ...view, running: false, stage: undefined, ticker: [] };
  // No exit after the turn started: the app closed mid-turn (main writes no exit on quit).
  // A turn that already asked, finished or got stuck needs nothing more.
  return view.running && !view.answered ? push(ended, { kind: "interrupted" }) : ended;
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

/** Minutes this turn has spent in the current step (retries of a gate included). */
export function elapsedMinutes(stage: DesignStage | undefined, now = Date.now()): number {
  return stage ? Math.max(0, Math.floor((now - stage.stepSince) / 60_000)) : 0;
}

/**
 * «Now» on the harness clock: the wall clock, or the latest event's time when the harness
 * runs ahead of it (a replay, a clock a few seconds apart).
 */
export function harnessNow(view: DesignView, wall = Date.now()): number {
  return Math.max(wall, view.lastEventAt ?? 0);
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

/** run.py's buttons after an edit («edit:keep:N» / «edit:revert:N»): which one the owner pressed. */
export function editAnswer(text: string): "keep" | "revert" | undefined {
  return /^edit:(keep|revert):\d+$/u.exec(text.trim())?.[1] as "keep" | "revert" | undefined;
}

/** The choice run.py offers after an edit: only its «edit:…» keys. */
export function editOptions(groups: DesignOptionGroup[]): boolean {
  const options = groups.flatMap((g) => g.options);
  return options.length > 0 && options.every((o) => /^edit:(keep|revert):\d+$/u.test(o.key));
}

/** The engine's «как рекомендуешь»: closes every open choice with the agent's recommendation. */
export const RECOMMEND_ANSWER = "как рекомендуешь";

/** A lettered option (Latin A–D or Cyrillic А–Г); run.py's word options («да», «смешать») are not. */
export function isLetterKey(key: string): boolean {
  return /^[A-DА-Г]$/u.test(key);
}

/** An option's label without the letter it repeats («A — прибор и три шага» → «прибор и три шага»). */
export function optionLabel(option: { key: string; label: string }): string {
  if (!isLetterKey(option.key)) return option.label;
  const rest = option.label.replace(new RegExp(`^${option.key}\\s*(?:[—–:.)-]\\s*)?`, "u"), "");
  return rest.trim();
}

/**
 * Owner's answer to a card. One question → the picked letter with its label, or a word option's
 * own key («да», «экран с тремя шагами»: run.py reads it as is); several → "1А 2Б 3А".
 * Undefined until every question has a pick.
 */
export function answerText(
  groups: DesignOptionGroup[],
  picks: Readonly<Record<number, string>>,
): string | undefined {
  if (groups.length === 0 || groups.some((_, i) => !picks[i])) return undefined;
  if (groups.length === 1) {
    const key = picks[0]!;
    if (!isLetterKey(key)) return key;
    const option = groups[0]!.options.find((o) => o.key === key);
    const label = option ? optionLabel(option) : "";
    return label ? `${key}. ${label}` : key;
  }
  return groups.map((_, i) => `${i + 1}${picks[i]}`).join(" ");
}
