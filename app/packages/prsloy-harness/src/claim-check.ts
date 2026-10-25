// Слова и факты (research/24 §4.1, этап H-2; research/22 §6.1 H6–H8) — за флагом "claimCheck" (по умолчанию выкл.).
//   - H6: та же команда тестов агента красная третий раз за сообщение — строка T3 в результате bash;
//   - H7: заглушка в новых строках edit/write — строка T4 в результате инструмента;
//   - H8: утверждения финального ответа («тесты проходят», «проверил», «запустил», «работает», «готово») против
//     фактов хода: вызовы и их коды после последней правки, прогон гейта, проверка страницы. Итог — сигналы ревьюеру
//     и факт в статусе хода, без возврата к работе и без прозы модели.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { TEST_FILE } from "./gate-signals.ts";
import { recordEvent } from "./learning-log.ts";
import type { ResolvedOptions } from "./options.ts";
import { appendText, contentText, keepStructured } from "./text.ts";
import { RUNS_PROGRAM, STUB, TEST_RUN } from "./turn-status.ts";

export type ClaimKind = "tests" | "checked" | "ran" | "works" | "done";

/** Утверждения в прошедшем или настоящем времени: «проверю», «можно запустить» сюда не попадают. */
const CLAIMS: readonly (readonly [ClaimKind, RegExp])[] = [
  [
    "tests",
    /(?<!\p{L})(?:(?:все\s+)?тест(?:ы)?\s+(?:проходят|проходит|прошли|прош[её]л|зелён\p{L}*|пройден[ыо]?)|проверк[аи]\s+(?:проходят|прошли|пройдены|зелён\p{L}*)|tests?\s+(?:pass(?:es|ed)?|are\s+green))(?!\p{L})/iu,
  ],
  ["checked", /(?<!\p{L})(?:проверил\p{L}*|протестировал\p{L}*|убедил(?:ся|ась))(?!\p{L})/iu],
  ["ran", /(?<!\p{L})запустил\p{L}*(?!\p{L})/iu],
  [
    "works",
    /(?<!\p{L})(?:(?:вс[её]|теперь|программа|бот|сайт|страница|игра|скрипт|код)\s+(?:\p{L}+\s+)?работает|работает\s+(?:без\s+ошибок|как\s+надо|правильно)|открывается\s+без\s+ошибок)(?!\p{L})/iu,
  ],
  ["done", /(?<!\p{L})(?:готово|сделано|сделал\p{L}*|исправил\p{L}*|починил\p{L}*)(?!\p{L})/iu],
];

/** Перед утверждением в том же предложении: условие, совет, просьба. */
const HEDGE =
  /(?<!\p{L})(?:если|можно|нужно|надо|попробуй\p{L}*|чтобы|когда|после того)(?!\p{L})/iu;
/** Отрицание вплотную перед утверждением: «не проверил», «так и не запустил». */
const NEGATION = /(?<!\p{L})(?:не|ни|нельзя|так и не)\s+(?:\p{L}+\s+)?$/iu;

/** Ответ сам говорит, что красное осталось («тест остаётся красным», «падает»): «исправил» тогда не ложь. */
const DISCLOSED_RED =
  /(?<!\p{L})(?:(?:оста[ёе]тся|остал(?:ся|ись|ось)|будет|будут)\s+красн\p{L}*|не\s+прох\p{L}*|не\s+прош\p{L}*|пада\p{L}*|упал\p{L}*|красн\p{L}*\s+тест|fails?|failing|still\s+red)(?!\p{L})/iu;

export interface Claim {
  kind: ClaimKind;
  quote: string;
}

export function findClaims(text: string): Claim[] {
  const out: Claim[] = [];
  const seen = new Set<ClaimKind>();
  for (const sentence of text.split(/(?<=[.!?…])\s+|\n+/)) {
    for (const [kind, re] of CLAIMS) {
      if (seen.has(kind)) continue;
      const m = re.exec(sentence);
      if (!m) continue;
      const before = sentence.slice(0, m.index);
      if (HEDGE.test(before) || NEGATION.test(before)) continue;
      seen.add(kind);
      out.push({ kind, quote: m[0] });
    }
  }
  return out;
}

export interface TurnCall {
  tool: string;
  command?: string;
  ok: boolean;
}

/** Что видел харнесс за сообщение пользователя. */
export interface ClaimState {
  calls: TurnCall[];
  /** Индекс последней успешной правки (edit/write) в `calls`; -1 — правок не было. */
  lastEdit: number;
  /** Текст последнего ответа модели. */
  final: string;
  /** Файлы, куда edit/write записали заглушку (H7). */
  stubs: string[];
  /** Красные прогоны тестов по команде (H6). */
  red: Map<string, number>;
}

export function createClaimState(): ClaimState {
  return { calls: [], lastEdit: -1, final: "", stubs: [], red: new Map() };
}

/** Факты, которых claim-check не видит сам: решение гейта и проверка страницы. */
export interface GateFacts {
  gate: "green" | "red" | undefined;
  page: boolean | undefined;
}

export interface ClaimFinding extends Claim {
  verdict: "unbacked" | "wrong";
  why: string;
}

/** Сверка утверждений с фактами хода. Пусто — всё подтверждено или утверждений нет. */
export function checkClaims(state: ClaimState, facts: GateFacts): ClaimFinding[] {
  const after = state.calls.slice(state.lastEdit + 1);
  const bashOk = after.filter((c) => c.tool === "bash" && c.ok);
  const testsOk = bashOk.some((c) => TEST_RUN.test(c.command ?? ""));
  const ranOk =
    bashOk.some((c) => RUNS_PROGRAM.test(c.command ?? "")) ||
    after.some((c) => c.tool === "bash_background" && c.ok);
  const since = state.lastEdit >= 0 ? "после последней правки" : "в этом ходе";
  const out: ClaimFinding[] = [];
  // Красное названо в самом ответе — «готово / работает» про остальное, не про проверку.
  const disclosed = DISCLOSED_RED.test(state.final);
  const wrong = (c: Claim, why: string) => out.push({ ...c, verdict: "wrong", why });
  const unbacked = (c: Claim, why: string) => out.push({ ...c, verdict: "unbacked", why });
  for (const c of findClaims(state.final)) {
    switch (c.kind) {
      case "tests":
        if (facts.gate === "red") wrong(c, "проверка проекта красная");
        else if (facts.gate !== "green" && !testsOk) unbacked(c, `${since} тесты не запускались`);
        break;
      case "checked":
        if (facts.gate === "red") wrong(c, "проверка проекта красная");
        else if (facts.gate !== "green" && facts.page !== true && !bashOk.length)
          unbacked(c, `${since} не было ни одного успешного запуска`);
        break;
      case "ran":
        if (!bashOk.length) unbacked(c, `${since} успешных запусков не было`);
        break;
      case "works":
        if (facts.gate === "red") {
          if (!disclosed) wrong(c, "проверка проекта красная");
        } else if (facts.page === false) wrong(c, "проверка страницы нашла ошибки");
        else if (facts.gate !== "green" && facts.page !== true && !ranOk && !testsOk)
          unbacked(c, `${since} программу не запускали и тесты не гоняли`);
        break;
      case "done":
        if (facts.gate === "red") {
          if (!disclosed) wrong(c, "проверка проекта красная");
        } else if (facts.page === false) wrong(c, "проверка страницы нашла ошибки");
        else if (state.stubs.length)
          wrong(c, `в коде остались заглушки (${state.stubs.join(", ")})`);
        break;
    }
  }
  return out;
}

/** Строки для «Сигналов харнесса» ревьюера. */
export function claimSignals(findings: readonly ClaimFinding[]): string[] {
  return findings.map(
    (f) =>
      `Слова и факты: в ответе «${f.quote}», но ${f.why}${f.verdict === "wrong" ? "" : " (не подтверждено)"}`,
  );
}

export const T3_SAME_RED =
  "[Тот же тест падает уже 3-й раз. Если он противоречит задаче, не подгоняй код и не трогай тест: оставь красным и объясни пользователю (или report_blocker).]";

export function stubNote(file: string, line: number, text: string): string {
  return `[В файле ${file} заглушка вместо кода: строка ${line} «${text.trim().slice(0, 80)}». Допиши или прямо скажи пользователю, что эта часть не сделана.]`;
}

/** Первая заглушка в новых строках (как stubFiles в статусе хода: `@abstractmethod` выше — не заглушка). */
export function firstStub(lines: readonly string[]): { line: number; text: string } | undefined {
  for (let i = 0; i < lines.length; i++)
    if (
      STUB.test(lines[i]!) &&
      !lines.slice(Math.max(0, i - 2), i).some((l) => /@abstractmethod/.test(l))
    )
      return { line: i + 1, text: lines[i]! };
  return undefined;
}

function newLines(tool: string, input: Record<string, unknown>): string[] {
  if (tool === "write" && typeof input.content === "string") return input.content.split("\n");
  if (tool === "edit" && Array.isArray(input.edits))
    return (input.edits as { newText?: unknown }[]).flatMap((e) =>
      typeof e?.newText === "string" ? e.newText.split("\n") : [],
    );
  return [];
}

/** Команда тестов без шума: пробелы, `cd … &&` в начале. */
function testKey(command: string): string {
  return command
    .replace(/^\s*cd\s+\S+\s*&&\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}

export interface ClaimTracker {
  state: ClaimState;
  /** Флаг на этот ход (читается на каждом сообщении пользователя). */
  enabled(): boolean;
  findings(facts: GateFacts): ClaimFinding[];
}

export function installClaimCheck(
  pi: ExtensionAPI,
  opts: ResolvedOptions,
  flag: () => boolean = () => true,
): ClaimTracker | undefined {
  if (opts.profile !== "code") return undefined;
  const state = createClaimState();
  let on = false;

  pi.on("before_agent_start", (event) => {
    if (event.messageType !== "user") return;
    Object.assign(state, createClaimState());
    on = flag();
  });

  pi.on("tool_result", (event, ctx) => {
    if (!on) return undefined;
    const input = (event.input ?? {}) as Record<string, unknown>;
    const command = typeof input.command === "string" ? input.command : undefined;
    state.calls.push({ tool: event.toolName, ...(command ? { command } : {}), ok: !event.isError });
    if ((event.toolName === "edit" || event.toolName === "write") && !event.isError) {
      state.lastEdit = state.calls.length - 1;
      const path = typeof input.path === "string" ? input.path : "";
      if (TEST_FILE.test(path.replace(/\\/g, "/"))) return undefined;
      const stub = firstStub(newLines(event.toolName, input));
      if (!stub) return undefined;
      if (!state.stubs.includes(path)) state.stubs.push(path);
      recordEvent(ctx, { kind: "claim.stub", tool: event.toolName, sig: "claim:stub" });
      return {
        content: appendText(event.content, stubNote(path, stub.line, stub.text)),
        ...keepStructured(event),
      };
    }
    if (event.toolName === "bash" && command && TEST_RUN.test(command) && event.isError) {
      const key = testKey(command);
      const n = (state.red.get(key) ?? 0) + 1;
      state.red.set(key, n);
      if (n !== 3) return undefined;
      recordEvent(ctx, { kind: "claim.same_red", sig: "claim:same-red", n });
      return { content: appendText(event.content, T3_SAME_RED), ...keepStructured(event) };
    }
    return undefined;
  });

  // Финальный ответ — последний текст ассистента без вызовов (гейт и статус читают его на settle).
  pi.on("message_end", (event) => {
    if (!on) return undefined;
    const message = event.message as unknown as { role: string; content?: unknown };
    if (message.role !== "assistant" || !Array.isArray(message.content)) return undefined;
    const parts = message.content as { type: string; text?: string }[];
    const text = contentText(parts.filter((p) => p.type === "text") as never);
    if (text.trim()) state.final = text;
    return undefined;
  });

  return {
    state,
    enabled: () => on,
    findings: (facts) => (on ? checkClaims(state, facts) : []),
  };
}
