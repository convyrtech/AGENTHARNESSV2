// Оценка по баллам: от 90 — «отлично», от 75 — «хорошо», от 60 — «удовлетворительно», иначе «неуд».
export function grade(score) {
  if (score >= 90) return "отлично";
  if (score >= 75) return "хорошо";
  if (score >= 60) return "удовлетворительно";
  return "неуд";
}
