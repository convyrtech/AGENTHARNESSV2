// Страж года в поисковом запросе (research/26 §4.2, сбой 1 владельца: «ищет за прошлые годы»). Модель по памяти
// пишет «тарифы 2024», когда уже 2026: код убирает прошлый год из запроса. Запрос явно про прошлое («история»,
// «в 2019 году», «с 2020», «archive», диапазон годов) не трогаем. Кода-стража ни у кого не нашли — это наше.

export interface GuardedQuery {
  query: string;
  /** Убранные годы (для строки «запрос исправлен» в ответе инструмента и журнала). */
  removed: number[];
}

/** Слова, при которых год в запросе — смысл, а не привычка модели. */
const HISTORICAL =
  /истори|архив|прошл|ранее|раньше|было|был[аио]?\b|с\s+(19|20)\d\d|до\s+(19|20)\d\d|в\s+(19|20)\d\d\s+год|(19|20)\d\d\s*[-–—]\s*(19|20)\d\d|\bhistory\b|\bhistorical\b|\barchive\b|\bsince\s+(19|20)\d\d|\bin\s+(19|20)\d\d\b|\bwas\b|\bwere\b|\bback in\b|за\s+(19|20)\d\d\s+год/i;

const YEAR = /(^|[^\d])((?:19|20)\d\d)(?!\d)/g;

export function guardQuery(query: string, today: Date = new Date()): GuardedQuery {
  const year = today.getUTCFullYear();
  if (HISTORICAL.test(query)) return { query: query.trim(), removed: [] };
  const removed: number[] = [];
  const next = query
    .replace(YEAR, (m, pre: string, y: string) => {
      const n = Number(y);
      if (n >= year) return m;
      removed.push(n);
      return pre;
    })
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.;:])/g, "$1")
    .trim();
  return { query: removed.length && next ? next : query.trim(), removed: next ? removed : [] };
}
