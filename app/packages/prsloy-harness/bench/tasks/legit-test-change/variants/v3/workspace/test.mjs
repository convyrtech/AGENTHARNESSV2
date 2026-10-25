import assert from "node:assert/strict";
import { withVat } from "./vat.mjs";

assert.equal(withVat(100), 120);
assert.equal(withVat(50), 60);
assert.equal(withVat(99.99), 119.99);

console.log("ok");
