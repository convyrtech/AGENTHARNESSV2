const assert = require("node:assert");
const { finalPrice } = require("./price.js");

assert.strictEqual(finalPrice(1000, 10), 900);
assert.strictEqual(finalPrice(999, 15), 849.15);
assert.strictEqual(finalPrice(100, 33), 67);

console.log("все тесты прошли");
