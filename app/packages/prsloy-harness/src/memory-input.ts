// M-2 (research/24 §3.1): вход экстрактора — только то, что пользователь напечатал сам.
// Берутся сообщения `role:user` из записей сессии Pi (сюда попадают и steer / follow-up, напечатанные во время
// работы агента — их нет в `before_agent_start`). Выкидываются:
// - блоки `<skill …>…</skill>` (текст навыка — не слова пользователя; то, что он дописал после, остаётся);
// - вставки: больше PASTE_CHARS символов или внутри ``` … ```;
// - сообщения с меткой интерфейса «из кнопки» / «вставлено», если пользователь их не правил: запись
//   `{type:"custom", customType: INPUT_SOURCE_TYPE, data:{source, edited}}` прямо перед сообщением
//   (`pi.appendEntry`, модель её не видит).
// Водяной знак — id последнего обработанного сообщения: второй проход по той же сессии берёт только новое.

/** Метка источника сообщения, которую ставит интерфейс (контракт для ui / features). */
export const INPUT_SOURCE_TYPE = "prsloy-input.source";

export interface InputSource {
  /** typed — напечатал; chip — кнопка-подсказка; paste — вставил; template — шаблон / рецепт. */
  source: "typed" | "chip" | "paste" | "template";
  /** Пользователь поправил текст из кнопки или вставки перед отправкой. */
  edited?: boolean;
}

/** Длиннее — вставка, а не напечатанное. */
export const PASTE_CHARS = 600;

export interface UserMessage {
  id: string;
  text: string;
  at: string;
  /** Перед сообщением был откат хода («Отменить»). */
  afterUndo?: boolean;
}

export interface ExtractorInput {
  messages: UserMessage[];
  /** id последнего сообщения пользователя в сессии (новый водяной знак), даже если оно отброшено. */
  watermark?: string;
  /** Сколько отброшено и почему — в отчёт и журнал. */
  dropped: { skill: number; paste: number; marked: number };
}

interface RawEntry {
  type?: string;
  id?: string;
  timestamp?: string;
  customType?: string;
  data?: unknown;
  message?: { role?: string; content?: unknown };
}

const SKILL_BLOCK = /<skill name="[^"]*" location="[^"]*">[\s\S]*?<\/skill>/gu;
const FENCED = /```[\s\S]*?```/gu;

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as { type?: string; text?: string }[])
    .map((p) => (p.type === "text" ? (p.text ?? "") : ""))
    .join("\n");
}

/** Текст, который пользователь напечатал сам; пусто — сообщение целиком не его. */
export function ownWords(text: string): { text: string; skill: boolean; paste: boolean } {
  let skill = false;
  let paste = false;
  let out = text.replace(SKILL_BLOCK, () => {
    skill = true;
    return "";
  });
  out = out.replace(FENCED, () => {
    paste = true;
    return "";
  });
  out = out.trim();
  if (out.length > PASTE_CHARS) {
    paste = true;
    out = "";
  }
  return { text: out, skill, paste };
}

/**
 * Сообщения пользователя после водяного знака. `entries` — записи сессии Pi в порядке файла (строки
 * session.jsonl или `sessionManager.getEntries()`). `undos` — времена «Отменить» в этой сессии (ISO, из
 * журнала обучения `turn.undo`): первое сообщение после отката помечается `afterUndo`.
 */
export function extractorInput(
  entries: readonly unknown[],
  watermark?: string,
  undos: readonly string[] = [],
): ExtractorInput {
  const messages: UserMessage[] = [];
  const dropped = { skill: 0, paste: 0, marked: 0 };
  let after = watermark === undefined;
  let last: string | undefined;
  let source: InputSource | undefined;
  for (const raw of entries) {
    const e = raw as RawEntry;
    if (e.type === "custom" && e.customType === INPUT_SOURCE_TYPE) {
      source = e.data as InputSource;
      continue;
    }
    if (e.type !== "message" || e.message?.role !== "user" || !e.id) continue;
    const mark = source;
    source = undefined;
    last = e.id;
    if (!after) {
      if (e.id === watermark) after = true;
      continue;
    }
    if (mark && mark.source !== "typed" && !mark.edited) {
      dropped.marked += 1;
      continue;
    }
    const own = ownWords(textOf(e.message.content));
    if (own.skill) dropped.skill += 1;
    if (own.paste) dropped.paste += 1;
    if (!own.text) continue;
    messages.push({ id: e.id, text: own.text, at: e.timestamp ?? "" });
  }
  // Водяного знака в файле нет (сессию переписали): начинаем с начала, а не теряем её.
  if (!after && watermark !== undefined) return extractorInput(entries, undefined, undos);
  for (const undo of undos) {
    const next = messages.find((m) => m.at > undo);
    if (next) next.afterUndo = true;
  }
  return { messages, ...(last ? { watermark: last } : {}), dropped };
}
