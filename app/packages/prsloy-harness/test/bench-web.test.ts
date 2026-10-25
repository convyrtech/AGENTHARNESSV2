import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { listTasks, TASKS_DIR } from "../bench/run.ts";

/** Реестры, как они отвечают (сокращённо): npm, PyPI, endoflife.date, редирект релизов GitHub. */
function registries(today = "2026-10-25") {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(`${today}T12:00:00Z`));
  vi.stubGlobal("fetch", async (input: string | URL) => {
    const url = String(input);
    const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200 });
    if (url === "https://registry.npmjs.org/zod/latest") return json({ version: "4.6.7" });
    if (url === "https://registry.npmjs.org/vite/latest") return json({ version: "8.3.5" });
    if (url === "https://pypi.org/pypi/requests/json") return json({ info: { version: "2.34.2" } });
    if (url === "https://endoflife.date/api/python.json")
      return json([
        { cycle: "3.14", eol: "2030-10-31", lts: false },
        { cycle: "3.10", eol: "2026-10-01", lts: false },
      ]);
    if (url === "https://endoflife.date/api/nodejs.json")
      return json([
        { cycle: "26", lts: "2026-10-28", eol: "2029-04-30", releaseDate: "2026-05-05" },
        { cycle: "24", lts: "2024-10-29", eol: "2028-04-30", releaseDate: "2025-05-06" },
        { cycle: "18", lts: "2022-10-25", eol: "2025-04-30", releaseDate: "2022-04-19" },
      ]);
    if (url === "https://github.com/BurntSushi/ripgrep/releases/latest")
      return new Response(null, {
        status: 302,
        headers: { location: "https://github.com/BurntSushi/ripgrep/releases/tag/15.2.0" },
      });
    throw new Error(`ECONNREFUSED ${url}`);
  });
}

async function runCheck(id: string, files: Record<string, string>) {
  const ws = mkdtempSync(join(tmpdir(), `web-${id}-`));
  cpSync(join(TASKS_DIR, id, "workspace"), ws, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(ws, name), text);
  const check = (await import(pathToFileURL(join(TASKS_DIR, id, "check.mjs")).href)) as {
    default: (i: { ws: string }) => Promise<{ ok: boolean; note: string }>;
  };
  return check.default({ ws });
}

describe("bench suite web (issue #23): coding tasks where a model without search is wrong", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("12 tasks, apart from the casual set; none runs with --fake (the answer is live)", () => {
    const web = listTasks(undefined, "web");
    expect(web).toHaveLength(12);
    expect(web.every((t) => t.suite === "web" && t.prompts.length === 1 && !t.fake)).toBe(true);
    expect(listTasks(undefined, "casual").some((t) => t.id.startsWith("web-"))).toBe(false);
  });

  it("exact and major versions against the npm registry; a pin against PyPI", async () => {
    registries();
    const pkg = (deps: object) => JSON.stringify({ name: "app", dependencies: deps });
    expect((await runCheck("web-npm-zod", { "package.json": pkg({ zod: "4.6.7" }) })).ok).toBe(
      true,
    );
    expect((await runCheck("web-npm-zod", { "package.json": pkg({ zod: "^4.6.7" }) })).ok).toBe(
      false,
    );
    expect((await runCheck("web-npm-zod", { "package.json": pkg({ zod: "3.23.8" }) })).note).toBe(
      "zod: 3.23.8, последняя 4.6.7",
    );
    const vite = (v: string) => JSON.stringify({ devDependencies: { vite: v } });
    expect((await runCheck("web-npm-vite", { "package.json": vite("^8.0.0") })).ok).toBe(true);
    expect((await runCheck("web-npm-vite", { "package.json": vite("^7.1.0") })).ok).toBe(false);
    expect((await runCheck("web-npm-vite", { "package.json": vite("^8.9.0") })).ok).toBe(false);
    const req = (r: string) => ({ "requirements.txt": `flask==3.0.0\nrequests==${r}\n` });
    expect((await runCheck("web-pypi-requests", req("2.34.2"))).ok).toBe(true);
    expect((await runCheck("web-pypi-requests", req("2.32.3"))).ok).toBe(false);
  });

  it("support today by endoflife.date: Python 3.10 ended on 2026-10-01, Node LTS is 24 until 26 turns LTS", async () => {
    registries();
    expect(
      (await runCheck("web-python310-support", { "answer.txt": "нет\n2026-10-01\n" })).ok,
    ).toBe(true);
    expect((await runCheck("web-python310-support", { "answer.txt": "да\n2026-10-31\n" })).ok).toBe(
      false,
    );
    const engines = (v: string) => JSON.stringify({ engines: { node: v } });
    expect((await runCheck("web-node-lts-engines", { "package.json": engines(">=24") })).ok).toBe(
      true,
    );
    expect((await runCheck("web-node-lts-engines", { "package.json": engines(">=26") })).ok).toBe(
      false,
    );
  });

  it("the latest GitHub release from the releases page redirect, no API limit", async () => {
    registries();
    const url =
      "https://github.com/BurntSushi/ripgrep/releases/download/15.2.0/ripgrep-15.2.0-x86_64-unknown-linux-musl.tar.gz";
    expect(
      (
        await runCheck("web-gh-ripgrep", {
          "install.sh": `curl -LO ${url}\ntar xzf ripgrep-*.tar.gz\n`,
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await runCheck("web-gh-ripgrep", {
          "install.sh": `curl -LO ${url.replace(/15\.2\.0/g, "14.1.1")}\ntar xzf x\n`,
        })
      ).note,
    ).toBe("в скрипте 14.1.1, последний 15.2.0");
  });
});
