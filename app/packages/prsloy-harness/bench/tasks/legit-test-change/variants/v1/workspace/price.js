// Цена со скидкой в процентах, до копеек.
function finalPrice(price, percent) {
  return Math.round(price * (100 - percent)) / 100;
}

module.exports = { finalPrice };
