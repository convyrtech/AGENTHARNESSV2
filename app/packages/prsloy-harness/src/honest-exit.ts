// Честный выход (research/24 §4.2; research/22 §6.1 H4): инструмент `report_blocker`. Флаг "honestExit", по
// умолчанию выкл.; решение — на старте сессии (набор инструментов в сессии не меняется: кэш промпта).
// Блокер снимает возвраты гейта «почини», только если код подтвердил причину:
//   - `test_conflicts_request`: названная проверка есть в тесте, который был до хода, и после первого красного
//     (гейт или упавший прогон) была хотя бы одна правка — иначе это «блокер до первой попытки»;
//   - `missing_file`: названного файла правда нет.
// Остальные причины (`no_access`, `too_hard`, `other`) код не проверит: карточка показывается после попытки,
// но возвраты остаются. Страж и статус работают и после блокера. Формат квитанции — по Gomez (research/22 §3).
import { existsSync } from "node:fs";
import { isAbsolute, join, normalize, relative } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFlags } from "./flags.ts";
import { TEST_FILE, testTexts } from "./gate-signals.ts";
import { recordEvent } from "./learning-log.ts";
import type { ResolvedOptions } from "./options.ts";
import { plainLine, showCard } from "./text.ts";
import type { TurnChanges } from "./turn-changes.ts";

export const BLOCKER_REASONS = [
  "test_conflicts_request",
  "missing_file",
  "no_access",
  "too_hard",
  "other",
] as const;
export type BlockerReason = (typeof BLOCKER_REASONS)[number];

/** Как `BlockerCardDetails` в packages/contracts/src/honesty.ts (карточка features): details сообщения. */
export interface BlockerCardDetails {
  what: string;
  why: string;
  need: string;
  reason?: string;
  options?: string[];
}

/** Общее для честного выхода и стоп-гейта в пределах сообщения пользователя. */
export interface HonestyState {
  /** Было красное: гейт вернул «почини» или прогон в bash упал. */
  redSeen: boolean;
  /** Правок (edit/write) после первого красного. */
  editsAfterRed: number;
  /** Блокер, причину которого подтвердил код: возвратов «почини» больше нет. */
  accepted: BlockerCardDetails | undefined;
  /** Блокер показан карточкой (подтверждён или неподтверждаемая причина после попытки). */
  reported: boolean;
}

export function createHonesty(): HonestyState {
  return { redSeen: false, editsAfterRed: 0, accepted: undefined, reported: false };
}

export const BLOCKER_TEXT = {
  accepted:
    "Записано, пользователь увидит карточку. Больше попыток не нужно: закончи ход коротким сообщением — что сделано и что не вышло.",
  shown:
    "Записано, пользователь увидит карточку. Но причину код проверить не может, поэтому проверка проекта остаётся: если она красная, чини дальше или оставь красной и коротко объясни.",
  again: "Блокер уже записан. Закончи ход коротким сообщением.",
  noAttempt:
    "Блокер не принят: ты ещё не пробовал. Запусти проверку, почини, что можешь, и только если проверка правда противоречит просьбе — вызови report_blocker снова.",
  noSuchCheck:
    "Блокер не принят: в тестах, которые были до этого хода, нет такой проверки. В `evidence` процитируй строку из старого теста, которая противоречит просьбе.",
  fileExists: "Блокер не принят: этот файл есть. Открой его и продолжай.",
  noPath: "Блокер не принят: в `evidence` укажи путь к файлу, которого нет.",
} as const;

const squash = (s: string) => s.replace(/\s+/g, "");

/** Старые тесты (начало хода по теневому git; без него — тестовые файлы на диске). */
async function oldTestTexts(cwd: string, changes: TurnChanges | undefined): Promise<string[]> {
  const files = await changes?.filesAtStart();
  if (!files) return testTexts(cwd);
  const out: string[] = [];
  for (const f of files.filter((f) => TEST_FILE.test(f)).slice(0, 50)) {
    const text = await changes?.fileAtStart(f);
    if (text !== undefined) out.push(text);
  }
  return out;
}

function inside(cwd: string, path: string): string | undefined {
  const abs = normalize(isAbsolute(path) ? path : join(cwd, path));
  const rel = relative(cwd, abs);
  return rel.startsWith("..") || isAbsolute(rel) ? undefined : abs;
}

export interface HonestExitDeps {
  state: HonestyState;
  changes?: TurnChanges | undefined;
}

export function installHonestExit(
  pi: ExtensionAPI,
  opts: ResolvedOptions,
  deps: HonestExitDeps = { state: createHonesty() },
): void {
  if (opts.profile !== "code") return;
  const { state, changes } = deps;
  const NAME = "report_blocker";

  // Флаг — на старте сессии: инструмент либо есть всю сессию, либо его нет.
  pi.on("session_start", () => {
    const active = pi.getActiveTools().filter((t) => t !== NAME);
    pi.setActiveTools(readFlags(opts.settingsPath).honestExit ? [...active, NAME] : active);
  });

  pi.on("before_agent_start", (event) => {
    if (event.messageType !== "user") return;
    Object.assign(state, createHonesty());
  });

  pi.on("tool_result", (event) => {
    if ((event.toolName === "bash" || event.toolName === "powershell") && event.isError)
      state.redSeen = true;
    else if ((event.toolName === "edit" || event.toolName === "write") && !event.isError) {
      if (state.redSeen) state.editsAfterRed += 1;
    }
    return undefined;
  });

  pi.registerTool({
    name: NAME,
    label: "не получилось",
    defaultActive: false,
    description:
      "Tell the user honestly that the task cannot be done as asked, instead of bending the code or the tests. Use it when a check contradicts the user's request (quote that check from an existing test in `evidence`), when a needed file is missing (its path in `evidence`), or when access is missing. Only after a real attempt. Do not change, skip or weaken tests to get green. Write `what`, `why`, `need` in Russian, plain words, no code. After it, end the turn with a short message.",
    promptSnippet: "Honestly report that the task cannot be done as asked (after a real attempt)",
    parameters: Type.Object({
      what: Type.String({ description: "What did not work, in Russian, one short phrase" }),
      reason: Type.Union(
        BLOCKER_REASONS.map((r) => Type.Literal(r)),
        { description: "Why, as a code" },
      ),
      why: Type.String({ description: "Why, in Russian plain words (no code, no stack traces)" }),
      need: Type.String({ description: "What the user can do or answer, in Russian" }),
      evidence: Type.Optional(
        Type.String({
          description:
            "test_conflicts_request: the contradicting line quoted from an existing test; missing_file: the path",
        }),
      ),
      tried: Type.Optional(Type.String({ description: "What you tried, briefly" })),
      options: Type.Optional(
        Type.Array(Type.String(), { maxItems: 3, description: "Up to 3 short ready answers" }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const reason = params.reason as BlockerReason;
      const reply = (text: string, verdict: string) => {
        recordEvent(ctx, { kind: "blocker.reported", sig: `blocker:${reason}` });
        if (verdict === "accepted")
          recordEvent(ctx, { kind: "blocker.accepted", sig: `blocker:${reason}` });
        else if (verdict === "rejected")
          recordEvent(ctx, { kind: "blocker.rejected", sig: `blocker:${reason}` });
        return { content: [{ type: "text" as const, text }], details: { reason, verdict } };
      };
      if (state.reported) return reply(BLOCKER_TEXT.again, "again");
      const evidence = params.evidence?.trim() ?? "";
      let confirmed = false;
      if (reason === "test_conflicts_request") {
        if (!state.redSeen || state.editsAfterRed < 1)
          return reply(BLOCKER_TEXT.noAttempt, "rejected");
        const quote = squash(evidence);
        const texts = quote.length >= 4 ? await oldTestTexts(ctx.cwd, changes) : [];
        if (!texts.some((t) => squash(t).includes(quote)))
          return reply(BLOCKER_TEXT.noSuchCheck, "rejected");
        confirmed = true;
      } else if (reason === "missing_file") {
        const path = evidence ? inside(ctx.cwd, evidence) : undefined;
        if (!path) return reply(BLOCKER_TEXT.noPath, "rejected");
        if (existsSync(path)) return reply(BLOCKER_TEXT.fileExists, "rejected");
        confirmed = true;
      } else if (!state.redSeen && state.editsAfterRed < 1 && !(await touchedAnything(changes)))
        return reply(BLOCKER_TEXT.noAttempt, "rejected");
      // Текст модели — человеку: одна строка, без «X: Y: …» (карточка сама ставит «Не получилось: …»).
      const card: BlockerCardDetails = {
        what: plainLine(params.what, 120),
        why: plainLine(params.why, 200),
        need: plainLine(params.need, 160),
        reason,
        ...(params.options?.length
          ? {
              options: params.options
                .map((o) => plainLine(o, 60))
                .filter(Boolean)
                .slice(0, 3),
            }
          : {}),
      };
      state.reported = true;
      if (confirmed) state.accepted = card;
      await showCard(pi, "prsloy-harness.blocker", `Не получилось: ${card.what}`, card);
      return reply(
        confirmed ? BLOCKER_TEXT.accepted : BLOCKER_TEXT.shown,
        confirmed ? "accepted" : "shown",
      );
    },
  });
}

/** Ход уже что-то менял (по теневому git) — значит, попытка была. */
async function touchedAnything(changes: TurnChanges | undefined): Promise<boolean> {
  const diff = await changes?.current();
  return (diff?.files.length ?? 0) > 0;
}
