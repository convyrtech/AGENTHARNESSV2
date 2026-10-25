// M-0 (research/24 §3.4, research/21): сравнение записей памяти по основам слов, а не по точному тексту.
// Нормализация: общие первые 4 буквы у основ ≥5 букв («платных» / «платить») и транслит латиница ↔ кириллица
// для коротких имён по скелету согласных («Mac» / «мак», «Google» / «гуглом»).
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
  // «никакого английского», «ничего лишнего».
  "никакой",
  "никакая",
  "никакое",
  "никакие",
  "никакого",
  "никакому",
  "никаким",
  "никаких",
  "никакую",
  "ничего",
  "ничем",
  "нисколько",
  "ничуть",
  // «PostgreSQL вместо SQLite» ≡ «PostgreSQL, не SQLite»: отрицается то, что после.
  "вместо",
  // «Пользователь запретил использовать React» ≡ «никогда не используй React».
  "запретил",
  "запретила",
  "запретили",
  "запрещает",
  "запрещаю",
]);

/**
 * Отрицания-глаголы: «React не используй» — отрицается и то, что перед ними. Остальные (предлоги «без»,
 * «вместо», «никакой …») — только то, что после: «минимализм без лишних картинок».
 */
const BACKWARD = new Set(["не", "нет", "никогда", "нельзя", "запрещено", "хватит"]);
/** Назад отрицание не переходит союз: «бухгалтер и не разбирается в коде». */
const CONJ = new Set(["и", "или", "либо", "а", "но", "да"]);

/**
 * Предлог после отрицаемого слова закрывает отрицание до конца части фразы: «никакого английского | в
 * интерфейсе» — интерфейс не отрицается. Сразу после отрицания предлог его не закрывает: «не на Node».
 */
const PREPS = new Set([
  "в", "во", "на", "у", "для", "при", "из", "от", "до", "к", "ко", "по", "о", "об", "про", "через", "над", "под",
]); // prettier-ignore

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
  // Как обращаться: «общаться / обращаться / отвечать на ты» — суть в «на ты».
  "общаться", "общайся", "обращаться", "обращайся", "обращайтесь", "отвечать", "отвечай", "отвечайте",
  // Глаголы, которыми запись рассказывает о пользователе: «работает на Mac», «выбрал PostgreSQL».
  "работает", "работаю", "работаем", "выбрал", "выбрала", "выбрали", "выбирает", "выбираем",
  "используем", "использую", "используют", "просят", "попросил", "попросила",
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
  // Третье лицо записи вместо первого лица цитаты: «у него нет» ← «у меня нет».
  "него", "нему", "ним", "нем", "ней", "нее", "них", "ними", "нею", "сам", "сама", "сами",
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

/** Имя посреди фразы (с большой буквы): «Аня» / «Аней» / «Анной» — одно имя по первым двум буквам. */
const NAME_PREFIX = "@";
const NAME = /^\p{Lu}[\p{Ll}]{1,7}$/u;

/** «на ты» / «на вы» — одно слово: иначе от «давай на ты» не остаётся ни одной основы. */
const ADDRESS = /(^|[^\p{L}])на\s+["«„“']?(ты|вы)(?=$|[^\p{L}])/giu;

export function signature(text: string): Signature {
  const stems: string[] = [];
  const negations: boolean[] = [];
  let negated = false;
  const prepared = text.replace(/ё/g, "е").replace(/Ё/g, "Е").replace(ADDRESS, "$1на$2");
  for (const clause of prepared.split(CLAUSE)) {
    const raw = clause.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    const all = raw.map((w) => w.toLowerCase());
    // Отрицание меняет смысл части фразы: «без умных слов и терминов», «не используй React». Предлог после
    // отрицаемого слова его закрывает: «никакого английского в интерфейсе».
    const neg = all.some((w) => NEGATION.has(w));
    negated ||= neg;
    let open = neg;
    let afterNegation = 0;
    let seenNegation = false;
    // Назад отрицание тоже доходит только до предлога: «тексты на сайте | без восклицательных знаков».
    const first = all.findIndex((w) => BACKWARD.has(w));
    // И слово в предложном обороте («в коде не разбираюсь») — обстоятельство, а не то, что отрицается.
    const before = (i: number) =>
      first > i &&
      !all.slice(i + 1, first).some((x) => PREPS.has(x) || CONJ.has(x)) &&
      !(i > 0 && PREPS.has(all[i - 1]!));
    all.forEach((w, i) => {
      if (NEGATION.has(w)) {
        seenNegation = true;
        open = true;
        afterNegation = 0;
        return;
      }
      if (seenNegation && open && afterNegation > 0 && PREPS.has(w)) open = false;
      if (MARKERS.has(w) || STOP.has(w) || w.length < 2) return;
      if (seenNegation) afterNegation += 1;
      const word = raw[i]!;
      const st =
        i > 0 && NAME.test(word) && /^[\p{Script=Cyrillic}]/u.test(word)
          ? `${NAME_PREFIX}${w.slice(0, 2)}`
          : stem(w);
      const pol = neg && (seenNegation ? open : before(i));
      const at = stems.indexOf(st);
      if (at >= 0) {
        negations[at] = negations[at]! || pol;
        return;
      }
      stems.push(st);
      negations.push(pol);
    });
  }
  return { stems, negations, negated };
}

/** Согласные латиницы и кириллицы в одном алфавите: «mac» и «мак», «google» и «гугл» дают один скелет. */
const CONSONANTS: Record<string, string> = {
  б: "b", в: "v", г: "g", д: "d", ж: "z", з: "z", к: "k", л: "l", м: "m", н: "n", п: "p", р: "r", с: "s",
  т: "t", ф: "f", х: "h", ц: "s", ч: "c", ш: "s", щ: "s",
  b: "b", c: "k", d: "d", f: "f", g: "g", h: "h", j: "z", k: "k", l: "l", m: "m", n: "n", p: "p", q: "k",
  r: "r", s: "s", t: "t", v: "v", w: "v", x: "k", z: "z",
}; // prettier-ignore

const LATIN = /^[a-z]+$/u;
const CYRILLIC = /^[а-я]+$/u;
/** Транслит — только для коротких имён (Mac, Google, Excel): длинные слова совпадают и так. */
const TRANSLIT_MAX = 8;

/** Скелет из согласных; подряд одинаковые — одна («apple» → «pl», «эппл» → «pl»). */
function skeleton(s: string): string {
  let out = "";
  for (const ch of s) {
    const c = CONSONANTS[ch];
    if (c && !out.endsWith(c)) out += c;
  }
  return out;
}

/** Одно имя латиницей и кириллицей: «Mac» / «мак», «Google» / «гуглом». */
function sameName(a: string, b: string): boolean {
  const [lat, cyr] = LATIN.test(a) ? [a, b] : [b, a];
  if (!LATIN.test(lat) || !CYRILLIC.test(cyr) || lat.length > TRANSLIT_MAX) return false;
  const k = skeleton(lat);
  return k.length >= 2 && k === skeleton(cyr);
}

/** Общий префикс-основа длинных слов: «платных» / «платить» (обе основы ≥5 букв). */
const PREFIX = 4;

/**
 * Две основы — одно слово: равны; одна начинается с другой (≥4 букв); обе ≥5 букв и первые 4 общие; или одно
 * имя латиницей и кириллицей.
 */
function same(a: string, b: string): boolean {
  if (a === b) return true;
  // Имя с большой буквы и то же слово, набранное строчными: «Аня» / «аней».
  if (a.startsWith(NAME_PREFIX) !== b.startsWith(NAME_PREFIX)) {
    const [name, plain] = a.startsWith(NAME_PREFIX) ? [a, b] : [b, a];
    return plain.length <= 4 && plain.startsWith(name.slice(NAME_PREFIX.length));
  }
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length >= PREFIX && long.startsWith(short)) return true;
  if (short.length > PREFIX && short.slice(0, PREFIX) === long.slice(0, PREFIX)) return true;
  return sameName(a, b);
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
/** Второй путь связи: доля основ цитаты, найденных в записи, и сколько записи должно быть из цитаты. */
export const QUOTE_COVERED = 0.67;
export const TEXT_COVERED_MIN = 0.5;
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
  const textCovered = matches(t.stems, q.stems).length / t.stems.length;
  if (textCovered >= LINK_THRESHOLD) return true;
  // Пересказ своими словами: почти всё сказанное пользователем есть в записи, а своих слов в ней немного.
  const quoteCovered = q.stems.length ? matches(q.stems, t.stems).length / q.stems.length : 0;
  return quoteCovered >= QUOTE_COVERED && textCovered >= TEXT_COVERED_MIN;
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

/**
 * То же правило, что `same`, но по хэшам: одна основа — префикс другой (≥4 букв), равна ей или обе ≥5 букв с
 * общими первыми четырьмя (`[0]` — хэш 4-буквенного префикса). Транслита по хэшам нет: «Mac» и «мак» в
 * tombstone — разные слова.
 */
function sameHashed(a: readonly string[], b: readonly string[]): boolean {
  const fullA = a[a.length - 1];
  const fullB = b[b.length - 1];
  if ((fullA !== undefined && b.includes(fullA)) || (fullB !== undefined && a.includes(fullB)))
    return true;
  return a.length >= 2 && b.length >= 2 && a[0] === b[0];
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
