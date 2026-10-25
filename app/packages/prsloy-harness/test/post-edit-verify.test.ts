import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { checkCssBalance, checkFile, checkHtml, stripJsonc } from "../src/checkers.ts";
import { resolveOptions } from "../src/options.ts";
import { installPostEditVerify } from "../src/post-edit-verify.ts";
import { MockPi } from "./mock-pi.ts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), "prsloy-verify-"));
  dirs.push(dir);
  return dir;
}

async function check(name: string, source: string, env = {}) {
  const dir = await tempDir();
  const path = join(dir, name);
  await writeFile(path, source);
  return checkFile(path, source, env);
}

describe("checkers", () => {
  it("js via node --check", async () => {
    expect(await check("a.js", "const a = 1;\nexport default a;\n")).toMatchObject({
      ok: true,
      tool: "node --check",
    });
    const bad = await check("a.mjs", "const a = ;\n");
    expect(bad?.ok).toBe(false);
    expect(bad?.message).toContain("SyntaxError");
    expect(bad?.message).not.toMatch(/\bat (?:wrapSafe|checkSyntax)|\u001b/);
  });

  it("checks ESM syntax in plain .js (node --check alone silently passes it)", async () => {
    const bad = await check("e.js", 'import a from "x";\nconst y = ;\n');
    expect(bad?.ok).toBe(false);
    expect(bad?.message).toContain("e.js:2");
    expect(bad?.message).not.toContain(".mjs");
    expect(await check("e.js", 'import a from "x";\nexport const y = a;\n')).toMatchObject({
      ok: true,
    });
  });

  it("JSX inside .js is rechecked with the typescript parser instead of failing", async () => {
    expect(
      await check(
        "App.js",
        'export default function App() { return <div className="a">hi</div>; }\n',
      ),
    ).toMatchObject({
      ok: true,
      tool: "typescript",
    });
  });

  it("ts/tsx via typescript transpile", async () => {
    expect(await check("a.ts", "const a: number = 1;\nexport { a };\n")).toMatchObject({
      ok: true,
      tool: "typescript",
    });
    expect(await check("a.tsx", "export const A = () => <b>ok</b>;\n")).toMatchObject({ ok: true });
    const bad = await check("a.ts", "function f(: number) {}\n");
    expect(bad?.ok).toBe(false);
    expect(bad?.message).toMatch(/a\.ts:1:\d+/);
  });

  it("ts without typescript falls back to Node's type stripping; tsx is then skipped", async () => {
    const noTs = { loadTypeScript: () => undefined };
    expect(await check("a.ts", "const a: number = 1;\n", noTs)).toMatchObject({
      ok: true,
      tool: "node strip-types",
    });
    expect((await check("a.ts", "const a: = 1;\n", noTs))?.ok).toBe(false);
    expect(await check("a.tsx", "export const A = () => <b/>;\n", noTs)).toBeUndefined();
  });

  it("json parse, with comments allowed in tsconfig", async () => {
    expect(await check("a.json", '{"a": 1}')).toMatchObject({ ok: true });
    const bad = await check("package.json", '{\n  "a": 1,\n}\n');
    expect(bad?.ok).toBe(false);
    expect(
      await check("tsconfig.json", '{\n  // comment\n  "a": "http://x", /* b */\n}\n'),
    ).toMatchObject({ ok: true });
    const src = '{"u": "a//b,]", /*x*/ "v": [1,],}';
    const stripped = stripJsonc(src);
    expect(stripped).toHaveLength(src.length);
    expect(JSON.parse(stripped)).toEqual({ u: "a//b,]", v: [1] });
  });

  it("devcontainer, eslintrc, biome and .vscode configs allow comments; line numbers stay right", async () => {
    const commented = '{\n  // comment\n  "a": 1,\n}\n';
    for (const name of [
      "devcontainer.json",
      ".eslintrc.json",
      "biome.json",
      "turbo.json",
      "tsconfig.app.build.json",
    ]) {
      expect(await check(name, commented)).toMatchObject({ ok: true });
    }
    const dir = await tempDir();
    await mkdir(join(dir, ".vscode"));
    expect(await checkFile(join(dir, ".vscode", "settings.json"), commented)).toMatchObject({
      ok: true,
    });
    const bad = await check("tsconfig.json", '{\n  /* long\n  comment */\n  "a": 1\n  "b": 2\n}\n');
    expect(bad?.message).toContain("строка 5");
  });

  it("python compile without writing __pycache__", async () => {
    const ok = await check("a.py", "def f():\n    return 1\n");
    expect(ok).toMatchObject({ ok: true, tool: "python compile" });
    const bad = await check("b.py", "def f(:\n    return 1\n");
    expect(bad?.ok).toBe(false);
    expect(bad?.message).toContain("SyntaxError");
  });

  it("python is skipped when there is none", async () => {
    expect(await check("a.py", "x = 1\n", { pythonPath: "/nonexistent/python" })).toBeUndefined();
  });

  it("css via postcss", async () => {
    expect(await check("a.css", "a { color: red; }\n")).toMatchObject({
      ok: true,
      tool: "postcss",
    });
    const bad = await check("a.css", "a { color: red;\n\nb { }\n");
    expect(bad?.ok).toBe(false);
    expect(bad?.message).toMatch(/a\.css:1:1: Unclosed block/);
  });

  it("CSS fallback without postcss: comments, strings, brackets", () => {
    expect(checkCssBalance("a { color: red; }\n/* ok */ b[x='}'] { }")).toEqual({
      ok: true,
      tool: "баланс скобок CSS",
    });
    expect(checkCssBalance("a { color: red;\n").message).toBe("не закрыта «{» (строка 1)");
    expect(checkCssBalance("a { }\n}").message).toBe("лишняя «}» (строка 2)");
    expect(checkCssBalance('a { content: "x; }').message).toContain("не закрыта строка");
    expect(checkCssBalance("/* open").message).toContain("не закрыт комментарий");
  });

  it("unknown types are not checked", async () => {
    expect(await check("a.md", "# hi")).toBeUndefined();
  });
});

describe("checkHtml", () => {
  it("accepts valid documents with void tags, optional closes, comments and scripts", () => {
    const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>a < b</title>
<style>div > p { color: red }</style></head>
<body>
<!-- <div> not a tag -->
<ul><li>one<li>two</ul>
<p>para<p>para2
<img src="a.png" alt="x > y"><br/>
<svg><path d="M0 0"/></svg>
<script>if (a < b && "</div>") {}</script>
</body></html>`;
    expect(checkHtml(html)).toEqual({ ok: true, tool: "баланс тегов" });
  });

  it("reports unclosed and stray tags with line numbers", () => {
    const r = checkHtml("<div>\n<section>\n<span>x</span>\n</div>\n</main>");
    expect(r.ok).toBe(false);
    expect(r.message).toContain("не закрыт <section> (строка 2) до </div> (строка 4)");
    expect(r.message).toContain("лишний </main> (строка 5)");
    expect(checkHtml("<div><span>x</span>").message).toContain("не закрыт <div> (строка 1)");
  });

  it("«/>» on a normal tag does not close it; on script it is an error; in svg it is fine", () => {
    expect(checkHtml('<script src="a.js"/>\n<p>x</p>').message).toContain(
      "<script …/> не закрывается",
    );
    expect(checkHtml('<div id="app"/>\n<p>x</p>').message).toContain("не закрыт <div> (строка 1)");
    expect(checkHtml('<svg><circle r="1"/><path d="M0"/></svg>').ok).toBe(true);
  });
});

describe("post-edit verify", () => {
  async function setup() {
    const dir = await tempDir();
    const pi = new MockPi(dir);
    installPostEditVerify(pi.api, resolveOptions());
    return { pi, dir };
  }

  it("appends the check to a successful write/edit result", async () => {
    const { pi, dir } = await setup();
    await writeFile(join(dir, "data.json"), '{"a": 1,}');
    const result = await pi.toolResult({
      toolName: "write",
      input: { path: "data.json" },
      text: "Wrote data.json",
    });
    expect(result.text).toContain(
      "Wrote data.json\n\n[Проверка синтаксиса (JSON.parse): ОШИБКА в data.json",
    );
    expect(result.text).toContain("Исправь это до следующего шага.");

    await writeFile(join(dir, "ok.js"), "let x = 1;\n");
    const ok = await pi.toolResult({
      toolName: "edit",
      input: { path: "ok.js" },
      text: "Edited ok.js",
    });
    expect(ok.text).toBe("Edited ok.js\n\n[Проверка синтаксиса (node --check): ок]");
  });

  it("skips failed edits, other tools and unknown file types", async () => {
    const { pi, dir } = await setup();
    await writeFile(join(dir, "a.js"), "let = ;");
    expect(
      (
        await pi.toolResult({
          toolName: "edit",
          input: { path: "a.js" },
          text: "fail",
          isError: true,
        })
      ).modified,
    ).toBe(false);
    expect(
      (await pi.toolResult({ toolName: "read", input: { path: "a.js" }, text: "x" })).modified,
    ).toBe(false);
    await writeFile(join(dir, "n.txt"), "x");
    expect(
      (await pi.toolResult({ toolName: "write", input: { path: "n.txt" }, text: "ok" })).modified,
    ).toBe(false);
  });
});
