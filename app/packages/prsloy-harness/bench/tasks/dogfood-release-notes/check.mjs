// Дирижёр, 26.10: «Новое» в RELEASE-NOTES по слитым веткам — по-русски, для казуала, без жаргона, только то, что
// человек заметит сам. Хорошо:
//   - остальной файл не тронут (заголовок, «Исправлено», «Известные ограничения» — байт в байт), заглушка убрана;
//   - в «Новое» 3–8 пунктов, текст по-русски, без жаргона и без внутренней кухни (стенд, счётчик токенов, бюджет);
//   - покрыто хотя бы 3 из 5 заметных вещей: старые тесты без спроса не трогает; Python проверяется и без pytest;
//     устаревшее описание проекта — по коду, с расхождением; модель, которая отказывалась отвечать длинно, отвечает;
//     после «ключ не подходит» нет лишней строки.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const JARGON =
  /pytest|unittest|venv|max_tokens|step.?down|fallback|turn.?status|stop.?gate|гейт|testGuard|staleDocs|AGENTS\.md|project_context|README|(?<!\d)40[0-9](?!\d)|(?<!\d)(?:64|32|16|8)\s?k(?!\p{L})|бенч|bench|замер|стенд|токен|infra_error|флаг|ветк|desktop\/|harness|харнесс|(?<!\p{L})(?:PR|CI|JSON|API|merge|regex)(?!\p{L})|счётчик|бюджет|prices|`/iu;
const TOPICS = [
  [
    /тест|проверк/iu,
    /без (?:вашей |твоей )?(?:просьб|спрос)|не (?:меня|трога|правит|исправля)|сам[аи]? не|предлож/iu,
  ],
  [/python|питон/iu, /провер/iu],
  [/описани/iu, /код|расход|устар/iu],
  [/модел/iu, /не отвеча|молч|отказ|коротк|короче|меньш|повтор/iu],
  [/ключ/iu, /лишн|больше не|исчез|убрал/iu],
];

function section(text, title) {
  const at = text.indexOf(`## ${title}`);
  if (at < 0) return undefined;
  const next = text.indexOf("\n## ", at + 1);
  return text.slice(at, next < 0 ? undefined : next + 1);
}

export default async function check({ ws, original }) {
  const path = join(ws, "RELEASE-NOTES.md");
  if (!existsSync(path)) return { ok: false, note: "нет RELEASE-NOTES.md" };
  const text = readFileSync(path, "utf8");
  const before = readFileSync(join(original, "RELEASE-NOTES.md"), "utf8");
  const kept =
    text.startsWith("# PRSLOY alpha.3\n\n## Новое") &&
    ["Исправлено", "Известные ограничения"].every((t) => section(text, t) === section(before, t));
  const fresh = section(text, "Новое") ?? "";
  const bullets = fresh.split("\n").filter((l) => /^\s*[-*•]\s+\S/.test(l));
  const placeholder = fresh.includes("<!--");
  const letters = fresh.replace(/[^\p{L}]/gu, "");
  const russian =
    letters.length > 0 &&
    (letters.match(/\p{Script=Cyrillic}/gu)?.length ?? 0) / letters.length > 0.85;
  const jargon = bullets.map((b) => JARGON.exec(b)?.[0]).filter(Boolean);
  const covered = TOPICS.filter(([a, b]) => bullets.some((l) => a.test(l) && b.test(l))).length;
  const ok =
    kept &&
    !placeholder &&
    bullets.length >= 3 &&
    bullets.length <= 8 &&
    russian &&
    !jargon.length &&
    covered >= 3;
  return {
    ok,
    note: [
      kept ? null : "остальной файл изменён",
      placeholder ? "заглушка осталась" : null,
      `пунктов ${bullets.length}`,
      russian ? null : "не по-русски",
      jargon.length ? `жаргон: ${[...new Set(jargon)].join(", ")}` : "без жаргона",
      `заметного покрыто ${covered}/5`,
    ]
      .filter(Boolean)
      .join(", "),
  };
}
