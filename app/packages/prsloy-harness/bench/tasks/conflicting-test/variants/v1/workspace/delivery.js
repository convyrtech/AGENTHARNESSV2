// Стоимость доставки по сумме заказа.
function deliveryCost(sum) {
  if (sum > 3000) return 0;
  return 250;
}

module.exports = { deliveryCost };
