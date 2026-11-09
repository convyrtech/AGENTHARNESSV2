import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";
const { hidden } = await import(new URL("../bench/lib/check-utils.mjs", import.meta.url).href);

const root = mkdtempSync(join(tmpdir(), "prsloy-hidden-check-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const cases: [string, number][] = [
  ["finalPrice(800, 25)", 600],
  ["finalPrice(10, 100)", 0],
];

describe("hidden module checks", () => {
  it("accepts a correct CommonJS export, including the Node 24 namespace marker", () => {
    writeFileSync(
      join(root, "correct.cjs"),
      "module.exports = { finalPrice: (p, d) => p - p * d / 100 };\n",
    );
    expect(hidden(root, "./correct.cjs", cases)).toEqual({ ok: true, passed: 2 });
  });

  it("ignores the CommonJS namespace marker when it is explicitly exported", () => {
    writeFileSync(
      join(root, "marker.mjs"),
      [
        "const api = { finalPrice: (p, d) => p - p * d / 100 };",
        "export default api;",
        "export { api as 'module.exports' };",
      ].join("\n"),
    );
    expect(hidden(root, "./marker.mjs", cases)).toEqual({ ok: true, passed: 2 });
  });

  it("preserves named ESM functions", () => {
    writeFileSync(
      join(root, "named.mjs"),
      "export const finalPrice = (p, d) => p - p * d / 100;\n",
    );
    expect(hidden(root, "./named.mjs", cases)).toEqual({ ok: true, passed: 2 });
  });

  it("still rejects incorrect calculations", () => {
    writeFileSync(join(root, "wrong.cjs"), "module.exports = { finalPrice: (p, d) => p - d };\n");
    expect(hidden(root, "./wrong.cjs", cases)).toEqual({ ok: false, passed: 0 });
  });

  it("does not count a throwing function as a passing answer", () => {
    writeFileSync(
      join(root, "throws.mjs"),
      "export function finalPrice() { throw new Error('no answer'); }\n",
    );
    expect(hidden(root, "./throws.mjs", cases)).toEqual({ ok: false, passed: 0 });
  });
});
