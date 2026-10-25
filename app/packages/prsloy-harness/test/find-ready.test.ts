import { describe, expect, it } from "vite-plus/test";
import {
  FindReady,
  formatDownloads,
  formatResult,
  installFindReady,
  rank,
} from "../src/find-ready.ts";
import { resolveOptions } from "../src/options.ts";
import { MockPi } from "./mock-pi.ts";
import { recordedFetch } from "./recorded-fetch.ts";

describe("find_ready on recorded registry answers", () => {
  it("npm: search + suggested names; deprecated goes last, made-up names are reported", async () => {
    const finder = new FindReady({ fetchImpl: recordedFetch() });
    const result = await finder.search("date format", "npm", [
      "request",
      "nonexistent-pkg-prsloy-zz",
    ]);
    expect(result.candidates.length).toBeLessThanOrEqual(5);
    expect(result.candidates.length).toBeGreaterThan(1);
    const request = result.candidates.find((c) => c.name === "request");
    expect(request?.deprecated).toContain("deprecated");
    expect(result.candidates.at(-1)?.name).toBe("request");
    for (const c of result.candidates.filter((c) => !c.deprecated)) {
      expect(c.weeklyDownloads).toBeGreaterThan(0);
      expect(c.install).toBe(`npm i ${c.name}`);
    }
    expect(result.missing).toEqual([{ ecosystem: "npm", name: "nonexistent-pkg-prsloy-zz" }]);
    expect(result.unavailable).toEqual([]);
  });

  it("pypi: suggested names and query words are checked in PyPI; downloads, license, release", async () => {
    const finder = new FindReady({ fetchImpl: recordedFetch() });
    const result = await finder.search("slugify", "pypi", [
      "python-slugify",
      "pyyaml",
      "pyyamlz-prsloy-fake",
    ]);
    expect(result.candidates.map((c) => c.name)).toEqual(["PyYAML", "python-slugify", "slugify"]);
    expect(result.candidates[1]).toMatchObject({
      license: "MIT",
      install: "pip install python-slugify",
      lastRelease: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    });
    expect(result.candidates[1]?.weeklyDownloads).toBeGreaterThan(1_000_000);
    expect(result.missing).toEqual([{ ecosystem: "pypi", name: "pyyamlz-prsloy-fake" }]);
  });

  it("the text for the model: candidates, warnings, missing names, advice", async () => {
    const finder = new FindReady({ fetchImpl: recordedFetch() });
    const result = await finder.search("date format", "npm", [
      "request",
      "nonexistent-pkg-prsloy-zz",
    ]);
    const text = formatResult("date format", result);
    expect(text).toContain("Готовые решения по «date format»:");
    expect(text).toMatch(/^1\. \S+ — /m);
    expect(text).toContain("⚠ устарел:");
    expect(text).toContain("Нет в npm: nonexistent-pkg-prsloy-zz — не ставь, такого пакета нет.");
    expect(text).toContain("Своё пиши, только если ни один не подходит");
  });

  it("a registry that does not answer in time is reported, not waited for", async () => {
    const hang = (async (_u: unknown, init?: RequestInit) =>
      new Promise<Response>((_r, reject) =>
        init?.signal?.addEventListener("abort", () => reject(new Error("timeout"))),
      )) as typeof fetch;
    const finder = new FindReady({ fetchImpl: hang, timeoutMs: 100 });
    const started = Date.now();
    const result = await finder.search("left pad", "npm");
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result.candidates).toEqual([]);
    expect(result.unavailable).toEqual(["поиск npm"]);
    expect(formatResult("left pad", result)).toContain("Не ответили: поиск npm.");
  });

  it("answers are cached: the same search makes no new requests", async () => {
    const calls: string[] = [];
    const finder = new FindReady({ fetchImpl: recordedFetch(calls) });
    await finder.search("slugify", "pypi", ["python-slugify"]);
    const first = calls.length;
    await finder.search("slugify", "pypi", ["python-slugify"]);
    expect(calls.length).toBe(first);
  });

  it("hints to search in English when the query is Russian", () => {
    expect(
      formatResult("транслитерация", { candidates: [], missing: [], unavailable: [] }),
    ).toContain("повтори запрос английскими словами");
  });

  it("rank and formatDownloads", () => {
    const base = { ecosystem: "npm" as const, description: "", install: "" };
    expect(
      rank([
        { ...base, name: "old", weeklyDownloads: 9e7, deprecated: "x" },
        { ...base, name: "small", weeklyDownloads: 10 },
        { ...base, name: "big", weeklyDownloads: 1e6 },
      ]).map((c) => c.name),
    ).toEqual(["big", "small", "old"]);
    expect(formatDownloads(60_312_459)).toBe("60,3 млн/нед");
    expect(formatDownloads(95_483)).toBe("95 тыс./нед");
    expect(formatDownloads(undefined)).toBe("загрузки неизвестны");
  });
});

describe("find_ready tool registration", () => {
  it("only in the «Код» profile", () => {
    const code = new MockPi();
    installFindReady(code.api, resolveOptions({ profile: "code" }));
    expect(code.tools.has("find_ready")).toBe(true);
    const design = new MockPi();
    installFindReady(design.api, resolveOptions({ profile: "design" }));
    expect(design.tools.has("find_ready")).toBe(false);
  });
});
