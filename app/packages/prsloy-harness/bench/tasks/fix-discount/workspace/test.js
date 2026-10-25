const assert = require("node:assert");
const { finalPrice } = require("./price.js");

assert.strictEqual(finalPrice(1000, 10), 900);
assert.strictEqual(finalPrice(500, 0), 500);
assert.strictEqual(finalPrice(200, 50), 100);
console.log("ok");
