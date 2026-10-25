import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { readZip } from "../design/zip.ts";
import { listProjectFiles, zipName, zipProject } from "./project-zip.ts";

function project() {
  const root = mkdtempSync(join(tmpdir(), "features-zip-"));
  const p = (rel: string, body = "x") => {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), body);
  };
  p("index.html", "<h1>Привет</h1>");
  p("css/site.css", "h1{}");
  p("bot/main.py", "print(1)");
  p(".env", "TOKEN=secret");
  p(".git/config", "x");
  p("node_modules/a/index.js");
  p("venv/bin/python");
  p(".venv/bin/python");
  p("bot/__pycache__/main.pyc");
  p("dist/index.html");
  return root;
}

describe("project zip", () => {
  it("takes the project and leaves out secrets, git, dependencies and builds", () => {
    const root = project();
    const outside = mkdtempSync(join(tmpdir(), "features-outside-"));
    writeFileSync(join(outside, "private.txt"), "не из проекта");
    symlinkSync(outside, join(root, "link"));
    symlinkSync(join(outside, "private.txt"), join(root, "private.txt"));
    const listed = listProjectFiles(root);
    expect(listed.ok && listed.files.map((f) => f.rel)).toEqual([
      "bot/main.py",
      "css/site.css",
      "index.html",
    ]);
  });

  it("puts everything under one folder and reads back", () => {
    const root = project();
    const listed = listProjectFiles(root);
    if (!listed.ok) throw new Error("too big");
    const entries = readZip(zipProject(listed.files, "vizitka"), {
      files: 10,
      bytes: 1 << 20,
      fileBytes: 1 << 20,
    });
    expect(entries.map((e) => e.name)).toEqual([
      "vizitka/bot/main.py",
      "vizitka/css/site.css",
      "vizitka/index.html",
    ]);
    expect(entries[2]?.data.toString()).toBe("<h1>Привет</h1>");
  });

  it("refuses a project over the limits", () => {
    const root = project();
    expect(listProjectFiles(root, { files: 2, bytes: 1 << 20 })).toEqual({
      ok: false,
      reason: "too_big",
    });
    expect(listProjectFiles(root, { files: 100, bytes: 10 })).toEqual({
      ok: false,
      reason: "too_big",
    });
  });

  it("names the file after the folder, safely", () => {
    expect(zipName("Визитка Анны")).toBe("Визитка Анны.zip");
    expect(zipName('a:b*c?"d')).toBe("a-b-c-d.zip");
    expect(zipName("..")).toBe("project.zip");
  });
});
