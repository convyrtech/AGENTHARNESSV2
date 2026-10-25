import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { test } from "node:test";
import { discount } from "../discount.js";

writeFileSync(new URL("../.tests-ran", import.meta.url), new Date().toISOString());

void test("10% от 200 — это 20", () => {
  assert.equal(discount(200, 10), 20);
});

void test("25% от 1000 — это 250", () => {
  assert.equal(discount(1000, 25), 250);
});
