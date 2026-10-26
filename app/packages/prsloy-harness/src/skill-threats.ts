// Статическая проверка навыков и уроков перед тем, как они попадут к модели (навыки пакета в CI, предложения
// тюнера #33). Категории — по NVIDIA SkillSpector (Apache-2.0; 71 шаблон в 17 категориях): только идеи, правила
// свои и узкие, чтобы наши восемь навыков проходили без ложных срабатываний. Сам SkillSpector гоняет CI
// (scripts/skill-scan.mts); здесь — то, что работает без Python и сети, в том числе в тюнере.
import { INVISIBLE } from "./hidden-text.ts";

export interface SkillThreat {
  /** Категория по SkillSpector: hidden-text, prompt-injection, exfiltration, remote-exec, credential-access, memory-poisoning, tool-poisoning. */
  category: string;
  file: string;
  line: number;
  detail: string;
}

const RULES: readonly (readonly [string, RegExp, string])[] = [
  [
    "prompt-injection",
    /\b(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+)?(?:the\s+)?(?:previous|prior|above|earlier|system|developer)\s+(?:instructions?|prompts?|rules?|messages?)\b/i,
    "просит игнорировать прежние инструкции",
  ],
  [
    "prompt-injection",
    /(?<!\p{L})(?:игнорируй|забудь|не\s+слушай)\s+(?:все\s+)?(?:предыдущие|прошлые|прежние|системные)\s+(?:инструкции|указания|правила)/iu,
    "просит игнорировать прежние инструкции",
  ],
  [
    "prompt-injection",
    /\b(?:you\s+are\s+now|from\s+now\s+on\s+you\s+are|new\s+system\s+prompt|reveal\s+(?:your|the)\s+system\s+prompt)\b/i,
    "подменяет роль или системный промпт",
  ],
  [
    "exfiltration",
    /\b(?:curl|wget|Invoke-WebRequest|iwr|fetch|requests\.post|httpx\.post)\b[^\n]*(?:\$\{?\w*(?:KEY|TOKEN|SECRET|PASSWORD)\w*|process\.env|os\.environ|\.env\b|id_rsa|\.ssh\/|\.aws\/credentials)/i,
    "отправляет ключи или файл с секретами по сети",
  ],
  [
    "remote-exec",
    /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z)?sh\b|\biex\s*\(\s*(?:iwr|Invoke-WebRequest|New-Object\s+Net\.WebClient)|base64\s+(?:-d|--decode)\b[^\n|]*\|\s*(?:ba)?sh\b/i,
    "скачивает и сразу исполняет код",
  ],
  [
    "credential-access",
    /(?:~|\$HOME|%USERPROFILE%)[\\/]\.(?:ssh|aws|gnupg|docker)[\\/]|\bid_(?:rsa|ed25519)\b|\.netrc\b|Login Data\b|\bkeychain\b/i,
    "читает ключи и пароли пользователя",
  ],
  [
    "memory-poisoning",
    /\b(?:remember|memorize|save\s+to\s+(?:your\s+)?memory)\b[^\n]{0,40}\b(?:forever|permanently|always|for\s+all\s+future)\b|(?<!\p{L})запомни\s+навсегда|(?<!\p{L})во\s+всех\s+будущих\s+(?:разговорах|сессиях)/iu,
    "пытается навсегда записать указание в память",
  ],
  [
    "tool-poisoning",
    /<\s*(?:IMPORTANT|SYSTEM|INSTRUCTIONS?)\s*>/,
    "скрытый блок указаний для модели (как в отравленном описании инструмента)",
  ],
];

/** HTML-комментарий с указанием модели внутри (а не обычная заметка автора). */
const COMMENT_PAYLOAD =
  /<!--(?:(?!-->)[\s\S]){0,2000}?\b(?:ignore|instruction|system|assistant|you\s+must|execute|run\s|curl|wget|send|игнорируй|инструкци|выполни|отправь)(?:(?!-->)[\s\S]){0,2000}?-->/i;

function lineOf(text: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) n += 1;
  return n;
}

/** Угрозы в одном файле навыка или урока. Пусто — чисто. */
export function skillThreats(file: string, text: string): SkillThreat[] {
  const out: SkillThreat[] = [];
  INVISIBLE.lastIndex = 0;
  const hidden = INVISIBLE.exec(text);
  INVISIBLE.lastIndex = 0;
  if (hidden)
    out.push({
      category: "hidden-text",
      file,
      line: lineOf(text, hidden.index),
      detail: `невидимый символ U+${hidden[0].codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`,
    });
  const comment = COMMENT_PAYLOAD.exec(text);
  if (comment)
    out.push({
      category: "hidden-text",
      file,
      line: lineOf(text, comment.index),
      detail: "HTML-комментарий с указанием модели",
    });
  for (const [category, re, detail] of RULES) {
    const m = re.exec(text);
    if (m)
      out.push({
        category,
        file,
        line: lineOf(text, m.index),
        detail: `${detail}: «${m[0].slice(0, 80)}»`,
      });
  }
  return out;
}

/** Все угрозы в наборе файлов (путь → текст). */
export function treeThreats(files: Readonly<Record<string, string>>): SkillThreat[] {
  return Object.entries(files).flatMap(([file, text]) => skillThreats(file, text));
}

export function threatLine(t: SkillThreat): string {
  return `${t.file}:${t.line}: ${t.category} — ${t.detail}`;
}
