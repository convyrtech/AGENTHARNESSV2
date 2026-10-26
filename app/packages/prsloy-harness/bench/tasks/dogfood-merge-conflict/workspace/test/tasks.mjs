// Счётчик задач замера: список должен совпадать с папками в tasks/.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";

const TASKS = new URL("../tasks/", import.meta.url);

<<<<<<< HEAD
test("has 5 casual tasks, each with task.json", () => {
=======
test("has 5 casual tasks (stale docs included), each with task.json", () => {
>>>>>>> desktop/harness-stale-docs
  const ids = readdirSync(TASKS).sort();
  assert.deepEqual(ids, [
    "explain-project",
    "fix-discount",
<<<<<<< HEAD
    "landing-coffee",
    "sales-summary",
=======
    "sales-summary",
    "stale-docs-naming",
>>>>>>> desktop/harness-stale-docs
    "visit-card",
  ]);
});
