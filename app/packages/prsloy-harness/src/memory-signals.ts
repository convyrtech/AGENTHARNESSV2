// M-2 (research/24 §3.1, §3.2): признаки того, что в словах пользователя есть что-то долговечное.
// Чистые функции, без модели: экстрактор (M-3) зовут только для сессий, где сигнал есть, и в промпт
// идут только сообщения с сигналом.
import { looksSensitive } from "./memory-checks.ts";
import { relation, signature } from "./memory-match.ts";

export type MemorySignalKind =
  /** «запомни», «всегда», «никогда», «по умолчанию», «впредь». */
  | "explicit"
  /** О себе и своём компьютере: «я не программист», «у меня Windows 10». */
  | "self"
  /** Как отвечать: «пиши проще», «объясняй по шагам». */
  | "style"
  /** Вкус результата: «люблю тёмные сайты». */
  | "taste"
  /** Решение проекта: «бот на Python», «хостинг — Timeweb». */
  | "decision"
  /** Одно требование в двух разных сообщениях. */
  | "repeat"
  /** Пользователь откатил ход, а потом что-то сказал: часто это исправление. */
  | "undo";

const words = (text: string) =>
  text
    .toLowerCase()
    .replace(/ё/g, "е")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

const EXPLICIT =
  /(^|[^\p{L}])(запомни|запомните|запомнить|помни|всегда|никогда|по умолчанию|впредь|отныне|каждый раз|в следующий раз|на будущее)([^\p{L}]|$)/u;
const SELF_WORDS = new Set([
  "я",
  "у меня",
  "мне",
  "меня",
  "мой",
  "моя",
  "моё",
  "мое",
  "мои",
  "моего",
  "моей",
  "моих",
]);
const SELF_FACT = /(^|[^\p{L}])(я|у меня|мне)\s+(не\s+)?(\p{L}+)/u;
/** «я» с глаголом действия — разовая просьба («я хочу кнопку»), не факт о себе. */
const ONE_OFF_VERB =
  /^(хочу|хотел|хотела|прошу|думаю|вижу|сделал|сделала|нажал|нажала|попробовал|попробовала|не понял|не поняла|понял|поняла|запустил|запустила|скачал|скачала|открыл|открыла|жду|нашел|нашла|забыл|забыла)$/u;
const STYLE =
  /(^|[^\p{L}])(пиши|пишите|отвечай|отвечайте|объясняй|объясняйте|говори|говорите|обращайся|обращайтесь|называй|называйте|зови|зовите|без терминов|без англицизмов|покороче|короче|подробнее|по-русски|на ты|на вы)([^\p{L}]|$)/u;
const TASTE =
  /(^|[^\p{L}])(люблю|не люблю|нравится|нравятся|не нравится|не нравятся|ненавижу|терпеть не могу|предпочитаю|обожаю|раздражает|раздражают)([^\p{L}]|$)/u;
const DECISION =
  /(^|[^\p{L}])(делаем на|пишем на|бот на|сайт на|проект на|используем|хостинг|деплой на|база данных|база —|базу —|база на|язык —|фреймворк|без react|без vue|только на)([^\p{L}]|$)/u;
/** Секреты, здоровье, деньги — не сохраняем (§3.2). */
const PRIVATE =
  /(^|[^\p{L}])(диагноз|болею|болезнь|болен|больна|диабет\p{L}*|рак|онколог\p{L}*|депресси\p{L}*|астм\p{L}*|инвалид\p{L}*|лекарств\p{L}*|давлени\p{L}*|беремен\p{L}*|зарплат\p{L}*|долг\p{L}*|кредит\p{L}*|ипотек\p{L}*|паспорт\p{L}*|снилс|инн)([^\p{L}]|$)/u;

/** Сигналы одного сообщения (без повторов и отката — для них нужна вся сессия). */
export function messageSignals(text: string): MemorySignalKind[] {
  const t = text.toLowerCase().replace(/ё/g, "е");
  if (!t.trim() || looksSensitive(t, t) || PRIVATE.test(t)) return [];
  const out: MemorySignalKind[] = [];
  if (EXPLICIT.test(t)) out.push("explicit");
  const self = SELF_FACT.exec(t);
  if (self && !ONE_OFF_VERB.test(self[4] ?? "") && words(t).some((w) => SELF_WORDS.has(w)))
    out.push("self");
  if (STYLE.test(t)) out.push("style");
  if (TASTE.test(t)) out.push("taste");
  if (DECISION.test(t)) out.push("decision");
  return out;
}

export interface SignalInput {
  id: string;
  text: string;
  /** Перед этим сообщением пользователь откатил ход. */
  afterUndo?: boolean;
}

export interface MessageSignals {
  id: string;
  kinds: MemorySignalKind[];
}

/** Повтор: та же просьба по основам (≥2 основы, та же полярность) в другом сообщении. */
function repeats(messages: readonly SignalInput[]): Set<string> {
  const sigs = messages.map((m) => signature(m.text));
  const out = new Set<string>();
  for (let i = 0; i < messages.length; i++) {
    for (let j = 0; j < i; j++) {
      if (sigs[i]!.stems.length < 2 || sigs[j]!.stems.length < 2) continue;
      if (relation(sigs[i]!, sigs[j]!) !== "same") continue;
      out.add(messages[i]!.id);
      out.add(messages[j]!.id);
    }
  }
  return out;
}

/** Сигналы по сессии: у каждого сообщения — свои виды; без сигналов сообщение в экстрактор не идёт. */
export function sessionSignals(messages: readonly SignalInput[]): MessageSignals[] {
  const repeated = repeats(messages);
  return messages
    .map((m) => {
      const kinds = messageSignals(m.text);
      const blocked =
        !m.text.trim() || looksSensitive(m.text, m.text) || PRIVATE.test(m.text.toLowerCase());
      if (!blocked && repeated.has(m.id)) kinds.push("repeat");
      if (!blocked && m.afterUndo) kinds.push("undo");
      return { id: m.id, kinds };
    })
    .filter((s) => s.kinds.length > 0);
}
