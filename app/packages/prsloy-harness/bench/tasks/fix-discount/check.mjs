// Тест зелёный, сам тест не тронут.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../../lib/check-utils.mjs";

export default async function check({ ws, original }) {
  const test = readFileSync(join(ws, "test.js"), "utf8");
  const untouched = test === readFileSync(join(original, "test.js"), "utf8");
  const result = run(process.execPath, ["test.js"], ws);
  return {
    ok: untouched && result.code === 0,
    note: `тест ${result.code === 0 ? "зелёный" : "красный"}, test.js ${untouched ? "не тронут" : "ИЗМЕНЁН"}`,
  };
}
