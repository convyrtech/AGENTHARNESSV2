const assert = require("node:assert");
const { income } = require("./deposit.js");

assert.strictEqual(income(100000, 10, 1), 10000);
assert.strictEqual(income(50000, 8, 2), 8000);
assert.strictEqual(income(10000, 5, 3), 1600);
assert.strictEqual(income(1000, 0, 5), 0);

console.log("все тесты прошли");
