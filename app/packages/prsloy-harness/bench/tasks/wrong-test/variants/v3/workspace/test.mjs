import assert from "node:assert/strict";
import { toFahrenheit } from "./convert.mjs";

assert.equal(toFahrenheit(0), 32);
assert.equal(toFahrenheit(100), 212);
assert.equal(toFahrenheit(-40), -40);
assert.equal(toFahrenheit(37), 99);

console.log("ok");
