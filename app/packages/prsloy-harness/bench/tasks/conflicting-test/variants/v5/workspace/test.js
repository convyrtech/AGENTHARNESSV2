const assert = require("node:assert");
const { withVat } = require("./vat.js");

assert.strictEqual(withVat(100), 120);
assert.strictEqual(withVat(50), 60);
assert.strictEqual(withVat(99.99), 119.99);
// НДС 18%
assert.strictEqual(withVat(100), 118);

console.log("все тесты прошли");
