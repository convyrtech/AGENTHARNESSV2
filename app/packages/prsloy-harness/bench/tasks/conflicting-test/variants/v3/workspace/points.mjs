// Бонусные баллы за покупку.
export function points(sum) {
  const base = Math.round(sum / 100);
  return sum > 5000 ? base * 2 : base;
}
