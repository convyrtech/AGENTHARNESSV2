// M-0 (research/24 §3.4, research/21): сравнение записей памяти по основам слов, а не по точному тексту.
// - Связь text ↔ quote: запись должна пересказывать слова пользователя. Обязательный префикс («Пользователь…»,
//   «В проекте…») и слова-маркеры («всегда», «запомни»…) в сравнении не участвуют.
// - Полярность: «не / нет / без / больше не / никогда / перестал» сравниваются отдельно. Разная полярность —
//   противоречие: не дубль, не отказ по забытому, и запись не пересказывает цитату.
// - Tombstone хранит хэши основ, не сами основы: забытое не лежит открытым текстом.
import { createHash } from "node:crypto";

/** Слова, которые меняют смысл на обратный. «больше не» покрыто «не». */
const NEGATION = new Set([
  "не",
  "нет",
  "без",
  "никогда",
  "ни",
  "перестал",
  "перестала",
  "перестали",
  "перестань",
  "хватит",
  "нельзя",
  "запрещено",
]);

/** Префикс записи и слова-маркеры: в сравнении не участвуют. */
const MARKERS = new Set([
  "пользователь", "пользователя", "пользователю", "пользователем",
  "проект", "проекте", "проекта", "проекту", "этом", "этого", "этот",
  "всегда", "запомни", "запомнить", "запомню", "помни", "по", "умолчанию",
  "важно", "обязательно", "пожалуйста", "впредь", "дальше", "теперь", "отныне",
  "просит", "просил", "просила", "хочет", "хотел", "хотела", "считает",
  // Общие слова записей о человеке и проекте: «использует», «на сайте», «сделай…».
  "использует", "использовать", "пользуется", "сайт", "сайта", "сайте", "сайту", "сайтом",
  "делай", "сделай", "сделать", "делать", "нужно", "нужен", "нужна", "нужны", "надо", "данных", "давай",
]); // prettier-ignore

/** Глаголы предпочтения и частые чередования, которые лёгкий стеммер не сводит к одной основе. */
const SYNONYMS: [RegExp, string][] = [
  [/^(люб|нрав|предпочит|обожа)/u, "люб"],
  [/^(пиш|писа|напиш|написа)/u, "пис"],
  [/^(хоч|хоте|хотя)/u, "хот"],
  [/^(объясн|поясн)/u, "объясн"],
  [/^(зов|зва|зват|назыв|назов)/u, "зов"],
];

/** Служебные слова. */
const STOP = new Set([
  "и", "в", "во", "на", "с", "со", "к", "ко", "о", "об", "обо", "у", "за", "из", "от", "до", "для", "при", "про",
  "что", "чтобы", "это", "эта", "эти", "то", "так", "как", "а", "но", "или", "же", "ли", "бы", "да", "уж", "ещё", "еще",
  "я", "мне", "меня", "мной", "мой", "моя", "моё", "мое", "мои", "моих", "моим", "моей", "моего", "ты", "тебе",
  "вы", "вам", "вас", "ваш", "ваша", "ваши", "он", "она", "оно", "они", "его", "её", "ее", "их", "им", "ему", "ей",
  "мы", "нам", "нас", "наш", "наша", "наши", "себе", "себя", "свой", "своя", "свои", "все", "всё", "всех",
  "the", "a", "an", "to", "of", "and", "or", "is", "are", "be", "i", "my", "me", "please", "always",
  "очень", "только", "просто", "тоже", "также", "там", "тут", "здесь", "когда", "где",
  "есть", "был", "была", "было", "были", "будет", "будь", "буду",
]); // prettier-ignore

/** Окончания по убыванию длины: лёгкий стеммер, чтобы «тёмные / тёмный / тёмных» совпадали. */
const ENDINGS = [
  "иями", "ями", "ами", "ией", "иях", "ого", "его", "ому", "ему", "ыми", "ими", "ая", "яя", "ое", "ее", "ые", "ие",
  "ый", "ий", "ой", "ую", "юю", "ом", "ем", "ам", "ям", "ах", "ях", "ов", "ев", "ей", "ий", "ия", "ие", "ию", "ью",
  "ть", "ти", "ешь", "ет", "ют", "ут", "ит", "ат", "ят", "ал", "ала", "ало", "али", "ил", "ила", "ило", "или",
  "ся", "сь", "ться", "тся", "ы", "и", "а", "я", "о", "е", "у", "ю", "ь", "s",
].sort((a, b) => b.length - a.length); // prettier-ignore

const STEM_MAX = 6;

function stem(word: string): string {
  for (const [re, base] of SYNONYMS) if (re.test(word)) return base;
  let w = word;
  for (const end of ENDINGS) {
    if (w.length - end.length >= 3 && w.endsWith(end)) {
      w = w.slice(0, -end.length);
      break;
    }
  }
  return w.slice(0, STEM_MAX);
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/ё/g, "е")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

export interface Signature {
  /** Основы значимых слов (без маркеров, служебных и отрицаний). */
  stems: string[];
  /** Для каждой основы: стоит ли она в отрицательной части фразы. */
  negations: boolean[];
  /** Есть ли отрицание хоть где-то (для коротких сообщений и журнала). */
  negated: boolean;
}

/** Части фразы: «бот на Python, не на Node» — отрицание относится только ко второй. */
const CLAUSE = /[,;.!?:()\n—]|\s(?:а|но|однако|зато)\s/u;

export function signature(text: string): Signature {
  const stems: string[] = [];
  const negations: boolean[] = [];
  let negated = false;
  for (const clause of text.toLowerCase().replace(/ё/g, "е").split(CLAUSE)) {
    const all = words(clause);
    // Отрицание меняет смысл всей части фразы: «без умных слов и терминов», «не используй React».
    const neg = all.some((w) => NEGATION.has(w));
    negated ||= neg;
    for (const w of all) {
      if (NEGATION.has(w) || MARKERS.has(w) || STOP.has(w) || w.length < 2) continue;
      const st = stem(w);
      const at = stems.indexOf(st);
      if (at >= 0) {
        negations[at] = negations[at]! || neg;
        continue;
      }
      stems.push(st);
      negations.push(neg);
    }
  }
  return { stems, negations, negated };
}

/** Две основы — одно слово: равны или одна начинается с другой (≥4 букв). */
function same(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 4 && long.startsWith(short);
}

/** Совпавшие основы: пары индексов (в `a`, в `b`). */
function matches(a: readonly string[], b: readonly string[]): [number, number][] {
  const out: [number, number][] = [];
  a.forEach((s, i) => {
    const j = b.findIndex((t) => same(s, t));
    if (j >= 0) out.push([i, j]);
  });
  return out;
}

/** Сходство основ: доля меньшего набора, найденная в большем (0…1). */
export function stemSimilarity(a: readonly string[], b: readonly string[]): number {
  if (!a.length || !b.length) return 0;
  const [small, big] = a.length <= b.length ? [a, b] : [b, a];
  return matches(small, big).length / small.length;
}

/** У совпавших основ разная полярность: «любит тёмные» / «не любит тёмные». */
function polarityClash(a: Signature, b: Signature): boolean {
  return matches(a.stems, b.stems).some(([i, j]) => a.negations[i] !== b.negations[j]);
}

/** Порог связи text ↔ quote (подобран на 100 размеченных парах, test/fixtures/memory-pairs.json). */
export const LINK_THRESHOLD = 0.75;
/** Порог дубля и забытого (§3.4 п. 6–7). */
export const SAME_THRESHOLD = 0.6;

/**
 * Запись пересказывает цитату: основы записи (без префикса и маркеров) в основном есть в цитате, и полярность
 * та же. «Пользователь хочет тёмные сайты» ← «люблю тёмные сайты» — да; ← «не люблю тёмные» — нет.
 */
export function textMatchesQuote(text: string, quote: string): boolean {
  const t = signature(text);
  const q = signature(quote);
  if (!t.stems.length) return false;
  if (polarityClash(t, q)) return false;
  return matches(t.stems, q.stems).length / t.stems.length >= LINK_THRESHOLD;
}

export type Relation = "same" | "contradicts" | "different";

/** Две записи об одном и том же: та же полярность — дубль, разная — противоречие. */
export function relation(a: Signature, b: Signature): Relation {
  if (stemSimilarity(a.stems, b.stems) < SAME_THRESHOLD) return "different";
  return polarityClash(a, b) ? "contradicts" : "same";
}

/** Хэш основы: tombstone хранит их, а не сами слова. */
export function stemHash(s: string): string {
  return createHash("sha256").update(`prsloy-memory:${s}`).digest("hex").slice(0, 12);
}

/** Хэши основы и её префиксов от 4 букв: так «темн» и «темны» совпадают и по хэшам. */
function prefixHashes(s: string): string[] {
  const out: string[] = [];
  for (let n = Math.min(4, s.length); n <= s.length; n++) out.push(stemHash(s.slice(0, n)));
  return [...new Set(out)];
}

export interface HashedSignature {
  /** На каждую основу — хэши её префиксов (последний — вся основа). */
  stems: string[][];
  /** Полярность каждой основы. */
  negations: boolean[];
}

export function hashedSignature(text: string): HashedSignature {
  const sig = signature(text);
  return { stems: sig.stems.map(prefixHashes), negations: sig.negations };
}

/** То же правило, что `same`, но по хэшам: одна основа — префикс другой (≥4 букв) или равна ей. */
function sameHashed(a: readonly string[], b: readonly string[]): boolean {
  const fullA = a[a.length - 1];
  const fullB = b[b.length - 1];
  return (fullA !== undefined && b.includes(fullA)) || (fullB !== undefined && a.includes(fullB));
}

/** Забытое возвращается: сходство основ ≥ SAME_THRESHOLD и у совпавших та же полярность. */
export function matchesForgotten(text: string, forgotten: HashedSignature): boolean {
  const sig = hashedSignature(text);
  if (!sig.stems.length || !forgotten.stems.length) return false;
  const pairs: [number, number][] = [];
  sig.stems.forEach((s, i) => {
    const j = forgotten.stems.findIndex((f) => sameHashed(s, f));
    if (j >= 0) pairs.push([i, j]);
  });
  if (pairs.some(([i, j]) => sig.negations[i] !== forgotten.negations[j])) return false;
  return pairs.length / Math.min(sig.stems.length, forgotten.stems.length) >= SAME_THRESHOLD;
}
