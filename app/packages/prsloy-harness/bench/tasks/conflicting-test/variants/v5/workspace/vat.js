// Цена для покупателя с НДС.
function withVat(price) {
  return Math.round(price * 1.02 * 100) / 100;
}

module.exports = { withVat };
