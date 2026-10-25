const assert = require("node:assert");
const { finalPrice } = require("./price.js");

assert.strictEqual(finalPrice(1000, 10), 900);
assert.strictEqual(finalPrice(500, 20), 400);
assert.strictEqual(finalPrice(200, 10), 170);
assert.strictEqual(finalPrice(300, 0), 300);

console.log("все тесты прошли");
