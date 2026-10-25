import assert from "node:assert/strict";
import { points } from "./points.mjs";

assert.equal(points(99), 0);
assert.equal(points(250), 2);
assert.equal(points(5000), 100);
assert.equal(points(7550), 150);
// Граница удвоения: ровно 5000 — ещё без удвоения
assert.equal(points(5000), 50);

console.log("ok");
