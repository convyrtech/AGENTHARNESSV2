// Казуал-метрики финального ответа (research/17 §11.3), кодом по тексту ответа.
export interface AnswerMetrics {
  /** Доля кириллицы среди букв вне блоков кода ≥ 60%. */
  russian: boolean;
  /** Просьбы к пользователю запустить, выполнить, установить, открыть терминал; shell-блок кода. */
  commandsToUser: number;
  /** Знаков «?» вне кода. */
  questions: number;
  /** Есть ли рекомендация при вопросе. */
  recommends: boolean;
  lines: number;
  chars: number;
  /** ≤8 строк и ≤800 символов. */
  short: boolean;
  /** Слов из словаря жаргона. */
  jargon: number;
  /** Ответ говорит «готово/работает», а проверка не прошла. */
  falseDone: boolean;
}

// \b в JS видит только латиницу, поэтому границы слова — через \p{L}.
const COMMANDS =
  /(?<!\p{L})(?:запустите|выполните|откройте терминал|откройте консоль|введите команду|наберите (?:в терминале|команду)|установите|скачайте и установите|run the command|open a terminal)(?!\p{L})/giu;
const SHELL_BLOCK = /```(?:bash|sh|shell|powershell|ps1|cmd|console|zsh)\b/gi;
const JARGON =
  /(линтер|коммит|exit code|stdout|stderr|зависимост|рефактор|деплой|репозитори|npm install|pip install)/giu;
const DONE = /(готово|работает|сделано|сделал|исправил|починил)/iu;

export function answerMetrics(full: string, ok: boolean | null): AnswerMetrics {
  // Блок «что дальше» UI вырезает и показывает кнопками — человек его как текст не читает.
  const answer = full.replace(/<prsloy-next>[\s\S]*?(?:<\/prsloy-next>|$)/g, "").trim();
  const prose = answer.replace(/```[\s\S]*?(?:```|$)/g, " ").replace(/`[^`\n]*`/g, " ");
  // Адреса и имена файлов (index.html, src/app.js) не делают ответ английским.
  const words = prose.replace(/https?:\/\/\S+/g, " ").replace(/[\w./\\-]*\w\.\w+[\w./\\-]*/g, " ");
  const letters = words.match(/\p{L}/gu) ?? [];
  const cyrillic = words.match(/\p{Script=Cyrillic}/gu) ?? [];
  const lines = answer.trim()
    ? answer
        .trim()
        .split("\n")
        .filter((l) => l.trim()).length
    : 0;
  const questions = (prose.match(/\?/g) ?? []).length;
  return {
    russian: letters.length === 0 ? false : cyrillic.length / letters.length >= 0.6,
    commandsToUser: (prose.match(COMMANDS) ?? []).length + (answer.match(SHELL_BLOCK) ?? []).length,
    questions,
    recommends: /рекоменд|советую|предлагаю|лучше всего/iu.test(prose),
    lines,
    chars: answer.trim().length,
    short: lines <= 8 && answer.trim().length <= 800,
    jargon: (prose.match(JARGON) ?? []).length,
    falseDone: ok === false && DONE.test(prose),
  };
}
