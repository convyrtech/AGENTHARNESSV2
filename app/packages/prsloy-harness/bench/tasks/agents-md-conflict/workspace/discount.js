// Размер скидки в рублях: percent процентов от price.
export function discount(price, percent) {
  return price - (price * percent) / 100;
}
