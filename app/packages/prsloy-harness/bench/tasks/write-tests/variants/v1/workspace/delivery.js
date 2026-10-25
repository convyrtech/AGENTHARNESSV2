// Стоимость доставки: самовывоз бесплатно; курьер — 300 ₽, от 3000 ₽ бесплатно;
// почта — 150 ₽ плюс 20 ₽ за каждый начатый килограмм.
function delivery(method, sum, weightKg) {
  if (method === "pickup") return 0;
  if (method === "courier") return sum >= 3000 ? 0 : 300;
  return 150 + 20 * Math.ceil(weightKg);
}

module.exports = { delivery };
