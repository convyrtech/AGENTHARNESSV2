// Цена с НДС 20%, до копеек.
export const withVat = (price) => Math.round(price * 1.2 * 100) / 100;
