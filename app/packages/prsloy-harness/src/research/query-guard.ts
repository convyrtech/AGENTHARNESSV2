// Страж года в поисковом запросе (research/26 §4.2, сбой 1 владельца: «ищет за прошлые годы»). Модель по памяти
// пишет «тарифы 2024», когда уже 2026: код убирает прошлый год из запроса. Запрос явно про прошлое («история»,
// «в 2019 году», «с 2020», «archive», диапазон годов) не трогаем. Кода-стража ни у кого не нашли — это наше.

export interface GuardedQuery {
  query: string;
  /** Убранные годы (для строки «запрос исправлен» в ответе инструмента и журнала). */
  removed: number[];
}

// В JS \b — граница только для латиницы: «был\b» не срабатывает никогда. Для русских слов — свои границы.
const RU_START = "(?<![а-яё])";
const RU_END = "(?![а-яё])";
const Y = "(?:19|20)\\d\\d";

/** Слова, при которых год в запросе — смысл, а не привычка модели. */
const HISTORICAL = new RegExp(
  [
    `${RU_START}(истори|архив|прошл|ранее|раньше)`,
    `${RU_START}был[аио]?${RU_END}`,
    `${RU_START}(с|до|после)\\s+${Y}`,
    `${RU_START}(в|за)\\s+${Y}\\s+год`,
    `${Y}\\s*[-–—]\\s*${Y}`,
    `\\b(history|historical|archive|was|were)\\b`,
    `\\b(since|in|before|after)\\s+${Y}\\b`,
    `\\bback in\\b`,
  ].join("|"),
  "i",
);

/**
 * Год — часть имени, а не дата: продукт («Windows Server 2019», «Visual Studio 2022», «Office 2016»), код ошибки
 * («ERROR 2002», «ошибка 2003», «port 2020»). Слово перед годом — из этого списка.
 */
const NAME_BEFORE =
  /^(windows|server|studio|office|excel|word|outlook|exchange|sql|sharepoint|project|visio|access|dynamics|autocad|revit|3ds|photoshop|illustrator|premiere|lightroom|cc|ce|edition|error|errno|err|code|код|ошибка|ошибки|exit|status|статус|port|порт|ГОСТ|gost|iso|rfc|stage|build|сборка|version|версия|mysql|mariadb|postgres|postgresql|oracle|mssql|intellij|idea|pycharm|webstorm|phpstorm|rider|clion|goland|datagrip|rubymine|unity|unreal|delphi|xcode|sap|1с|1c|ue)$/i;

/** Запрос про ошибку или соединение: числа в нём — коды («mysql 2002 socket»), годы не трогаем. */
const CODE_CONTEXT =
  /\b\w*(Error|Exception)\b|\b(error|errno|socket|connect|connection|refused|timeout|failed|exit code|status code|port)\b|ошибк|не удаётся|не удается|соединени|сокет/i;

/**
 * Год отдельным словом: перед ним начало, пробел или скобка, после — конец, пробел или знак препинания. Точка с
 * цифрой после — это версия («IntelliJ IDEA 2024.2», «Unity 2022.3»), не год.
 */
const YEAR = new RegExp(`(^|[\\s(«"])(${Y})(?=$|[\\s),;:!?»"]|\\.(?!\\d))`, "g");

export function guardQuery(query: string, today: Date = new Date()): GuardedQuery {
  const year = today.getUTCFullYear();
  if (HISTORICAL.test(query) || CODE_CONTEXT.test(query))
    return { query: query.trim(), removed: [] };
  const removed: number[] = [];
  const next = query
    .replace(YEAR, (m, pre: string, y: string, at: number) => {
      const n = Number(y);
      if (n >= year) return m;
      const before = /([\p{L}\d+#.-]+)\s*$/u.exec(query.slice(0, at + pre.length))?.[1] ?? "";
      // «ISO 9001 2015»: год после номера (не года) — часть названия стандарта
      if (NAME_BEFORE.test(before) || (/^\d+$/.test(before) && !new RegExp(`^${Y}$`).test(before)))
        return m;
      removed.push(n);
      return pre;
    })
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.;:])/g, "$1")
    .trim();
  return { query: removed.length && next ? next : query.trim(), removed: next ? removed : [] };
}
