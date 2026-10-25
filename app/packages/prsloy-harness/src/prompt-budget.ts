// Общий бюджет памяти и уроков в системном промпте (research/18 §6.1, §6.6): ≤3 800 символов. Проверяется кодом:
// если разделы вместе длиннее, сначала с конца режутся уроки (их польза для кода не доказана), потом память.
export const MEMORY_LESSONS_MAX_CHARS = 3800;

function trimLines(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const lines = text.split("\n");
  // Первая строка — заголовок раздела: без записей он не нужен.
  while (lines.length > 1 && lines.join("\n").length > maxChars) lines.pop();
  return lines.length > 1 ? lines.join("\n") : "";
}

export function fitPromptBudget(
  sections: { memory: string; lessons: string },
  max = MEMORY_LESSONS_MAX_CHARS,
): { memory: string; lessons: string } {
  const memory = trimLines(sections.memory, max);
  const lessons = trimLines(sections.lessons, Math.max(0, max - memory.length));
  return { memory, lessons };
}
