function formatPrice(value) {
  return `${value.toFixed(2)} ₽`;
}

function calcTotal(items) {
  return items.reduce((sum, item) => sum + item.price * item.qty, 0);
}

module.exports = { formatPrice, calcTotal };
