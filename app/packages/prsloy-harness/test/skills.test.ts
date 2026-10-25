// Курированные навыки (S9): комплект совпадает с skills/, пределы ≤12 / ≤3 файла / описание ≤200, Pi грузит их без
// замечаний, ссылки — только на официальные доки, флаг, учёт «загружен и использован».
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import { afterAll, describe, expect, it } from "vite-plus/test";
import { collectSkills } from "../scripts/build-skills.mts";
import {
  configureLearning,
  onLearningEvent,
  recordEvent,
  type LearningEvent,
} from "../src/learning-log.ts";
import { resolveOptions } from "../src/options.ts";
import {
  installSkills,
  materializeSkills,
  SKILL_DESCRIPTION_MAX,
  SKILL_FILES_MAX,
  SKILLS_MAX,
  skillOfPath,
  skillsVersion,
} from "../src/skills.ts";
import { SKILL_FILES } from "../src/skills-bundle.ts";
import { CHROMIUM, loadPlaywright } from "./playwright.ts";
import { checkPage } from "../src/page-check.ts";
import { MockPi } from "./mock-pi.ts";

const root = mkdtempSync(join(tmpdir(), "prsloy-skills-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
configureLearning({ enabled: true, dir: join(root, "learning") });

/** Официальные доки и сами проекты; всё остальное в навыке — выдумка, пока не доказано обратное. */
const OFFICIAL = [
  "developer.mozilla.org",
  "docs.python.org",
  "docs.python-telegram-bot.org",
  "core.telegram.org",
  "pandas.pydata.org",
  "openpyxl.readthedocs.io",
  "requests.readthedocs.io",
  "www.crummy.com",
  "www.rfc-editor.org",
  "docs.pytest.org",
  "nodejs.org",
  "docs.npmjs.com",
  "packaging.python.org",
  "pypi.org",
  "formspree.io",
];

describe("skills bundle", () => {
  it("src/skills-bundle.ts is generated from skills/ (run scripts/build-skills.mts after editing)", () => {
    expect(SKILL_FILES).toEqual(collectSkills());
  });

  it(`≤${SKILLS_MAX} skills, ≤${SKILL_FILES_MAX} files each, SKILL.md with name = folder and description ≤${SKILL_DESCRIPTION_MAX}`, () => {
    const names = Object.keys(SKILL_FILES);
    expect(names).toEqual([
      "canvas-game",
      "excel-csv",
      "explain-project",
      "fix-code",
      "python-windows",
      "site-landing",
      "telegram-bot",
      "web-scraper",
    ]);
    expect(names.length).toBeLessThanOrEqual(SKILLS_MAX);
    for (const [name, files] of Object.entries(SKILL_FILES)) {
      expect(Object.keys(files).length, name).toBeLessThanOrEqual(SKILL_FILES_MAX);
      const md = files["SKILL.md"]!;
      const front = /^---\nname: (.+)\ndescription: "(.+)"\n---\n/.exec(md);
      expect(front?.[1], name).toBe(name);
      expect(front![2]!.length, name).toBeLessThanOrEqual(SKILL_DESCRIPTION_MAX);
      expect(md, name).toContain("## Sources");
    }
  });

  it("Pi loads every skill from the laid-out folder without warnings", () => {
    const dir = materializeSkills(join(root, "pi"));
    const { skills, diagnostics } = loadSkillsFromDir({ dir, source: "test" });
    expect(diagnostics).toEqual([]);
    expect(skills.map((s) => s.name).sort()).toEqual(Object.keys(SKILL_FILES));
  });

  it("links go only to official docs and project sites", () => {
    for (const [name, files] of Object.entries(SKILL_FILES))
      for (const text of Object.values(files))
        for (const url of text.match(/https?:\/\/[^\s)>"'`]+/g) ?? []) {
          if (/formspree\.io\/f\/\{form_id\}|example\.com|127\.0\.0\.1/.test(url)) continue;
          expect(url.startsWith("https://"), `${name}: ${url}`).toBe(true);
          expect(OFFICIAL, `${name}: ${url}`).toContain(new URL(url).host);
        }
  });

  it("laid out once per version; unchanged files are not rewritten; another version — another folder", () => {
    const base = join(root, "versions");
    const dir = materializeSkills(base);
    expect(dir).toBe(join(base, skillsVersion()));
    const file = join(dir, "telegram-bot", "SKILL.md");
    expect(readFileSync(file, "utf8")).toBe(SKILL_FILES["telegram-bot"]!["SKILL.md"]);
    writeFileSync(file, "сломано");
    materializeSkills(base);
    expect(readFileSync(file, "utf8")).toBe(SKILL_FILES["telegram-bot"]!["SKILL.md"]);
    const other = { x: { "SKILL.md": "---\nname: x\ndescription: y\n---\n" } };
    expect(skillsVersion(other)).not.toBe(skillsVersion());
  });

  it("which skill a read call loads", () => {
    const dir = join(root, "kit");
    expect(skillOfPath(dir, join(dir, "excel-csv", "SKILL.md"), "/x")).toBe("excel-csv");
    expect(skillOfPath(dir, join(dir, "excel-csv", "read_table.py"), "/x")).toBe("excel-csv");
    expect(skillOfPath(dir, join(dir, "nope", "SKILL.md"), "/x")).toBeUndefined();
    expect(skillOfPath(dir, "index.html", "/x")).toBeUndefined();
  });
});

describe("skills in the harness", () => {
  function setup(flags: Record<string, unknown>) {
    const settingsPath = join(root, `flags-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(settingsPath, JSON.stringify(flags));
    const pi = new MockPi(root);
    installSkills(pi.api, resolveOptions({ profile: "code", settingsPath }), {
      dir: join(root, "h"),
    });
    const discover = async () => {
      const [h] = pi.handlers.get("resources_discover") ?? [];
      return (await h!({ type: "resources_discover", cwd: root, reason: "startup" }, pi.ctx)) as {
        skillPaths?: string[];
      };
    };
    return { pi, discover };
  }

  it("off by default: no skills; on — the laid-out folder", async () => {
    expect(await setup({}).discover()).toEqual({});
    const on = await setup({ skills: true }).discover();
    expect(on.skillPaths).toEqual([join(root, "h", skillsVersion())]);
  });

  it("reading SKILL.md is «loaded»; a green turn after it is «used», a red one is not", async () => {
    const { pi, discover } = setup({ skills: true });
    const [dir] = (await discover()).skillPaths!;
    const events: LearningEvent[] = [];
    const off = onLearningEvent((_s, e) => {
      if (e.kind.startsWith("skill.")) events.push(e);
    });
    const read = async (path: string) => {
      for (const h of pi.handlers.get("tool_call") ?? [])
        await h({ type: "tool_call", toolName: "read", toolCallId: "t", input: { path } }, pi.ctx);
    };
    await read(join(dir!, "excel-csv", "SKILL.md"));
    await read(join(dir!, "excel-csv", "read_table.py"));
    await read(join(root, "data.csv"));
    recordEvent(pi.ctx, { kind: "turn.end", outcome: "green", n: 3 });
    await read(join(dir!, "telegram-bot", "SKILL.md"));
    recordEvent(pi.ctx, { kind: "turn.end", outcome: "red", n: 1 });
    off();
    expect(events).toEqual([
      { kind: "skill.loaded", tool: "read", sig: "skill:excel-csv" },
      { kind: "skill.used", sig: "skill:excel-csv" },
      { kind: "skill.loaded", tool: "read", sig: "skill:telegram-bot" },
    ]);
  });

  it("only in the Code profile", () => {
    const pi = new MockPi(root);
    installSkills(pi.api, resolveOptions({ profile: "design" }));
    expect(pi.handlers.get("resources_discover")).toBeUndefined();
  });
});

describe("skill templates run", () => {
  const python = ["python3", "python"].find((p) => spawnSync(p, ["--version"]).status === 0);

  it.skipIf(!python)("bot.py and read_table.py compile", () => {
    const dir = materializeSkills(join(root, "py"));
    for (const file of ["telegram-bot/bot.py", "excel-csv/read_table.py"]) {
      const r = spawnSync(python!, ["-m", "py_compile", join(dir, file)], { encoding: "utf8" });
      expect(r.status, `${file}: ${r.stderr}`).toBe(0);
    }
  });

  it("the page templates open clean in Chromium (no browser — skipped)", async (t) => {
    const pw = await loadPlaywright();
    if (!pw) return t.skip();
    const dir = materializeSkills(join(root, "pages"));
    for (const [skill, file] of [
      ["site-landing", "template.html"],
      ["canvas-game", "game.html"],
    ] as const) {
      const project = mkdtempSync(join(root, `${skill}-`));
      writeFileSync(join(project, "index.html"), readFileSync(join(dir, skill, file), "utf8"));
      const r = await checkPage(project, { playwright: pw, executablePath: CHROMIUM });
      expect(r?.issues, skill).toEqual([]);
    }
  }, 60_000);
});

describe("skills name only tools the harness really has", () => {
  it("find_ready, request_secret, ask_user, bash_background, web_fetch, report_blocker: each one a skill names is registered", async () => {
    const { createPrsloyHarness } = await import("../src/index.ts");
    const { MockPi } = await import("./mock-pi.ts");
    const pi = new MockPi(tmpdir());
    createPrsloyHarness({ outputDir: join(tmpdir(), "prsloy-skills-tools"), profile: "code" })(
      pi.api,
    );
    const registered = new Set(pi.tools.keys());
    const known = [
      "find_ready",
      "request_secret",
      "ask_user",
      "bash_background",
      "process",
      "web_fetch",
      "web_search",
      "report_blocker",
    ];
    const named = new Set<string>();
    for (const files of Object.values(collectSkills())) {
      for (const file of Object.values(files)) {
        for (const tool of known) if (new RegExp(`\\b${tool}\\b`).test(file)) named.add(tool);
      }
    }
    expect([...named].sort()).toEqual(
      expect.arrayContaining(["ask_user", "bash_background", "find_ready", "request_secret"]),
    );
    for (const tool of named) expect(registered.has(tool), tool).toBe(true);
  });
});
