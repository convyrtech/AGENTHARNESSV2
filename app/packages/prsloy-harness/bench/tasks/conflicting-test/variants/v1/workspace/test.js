const assert = require("node:assert");
const { deliveryCost } = require("./delivery.js");

// Обычный заказ
assert.strictEqual(deliveryCost(1000), 300);
// Большой заказ — бесплатно
assert.strictEqual(deliveryCost(5000), 0);
// Ровно 3000 — уже бесплатно
assert.strictEqual(deliveryCost(3000), 0);
// Граница: при 3000 доставка ещё платная
assert.strictEqual(deliveryCost(3000), 300);

console.log("все тесты прошли");
