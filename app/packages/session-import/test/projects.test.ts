import { afterEach, describe, expect, it } from "vite-plus/test";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { realpathSync } from "node:fs";
import { resolveProject } from "../src/projects.ts";
import { cleanTemp, tempDir } from "./helpers.ts";

afterEach(cleanTemp);

describe("resolveProject", () => {
  it("returns the real folder for an existing project", async () => {
    const root = await tempDir();
    const project = join(root, "Мой проект");
    await mkdir(project);
    expect(resolveProject(project, { home: join(root, "дом") })).toBe(realpathSync.native(project));
    if (process.platform !== "win32") {
      await symlink(project, join(root, "ссылка"));
      expect(resolveProject(join(root, "ссылка"), { home: root })).toBe(
        realpathSync.native(project),
      );
    }
  });

  it("skips missing folders, files, home, disk root and the temp folder", async () => {
    const root = await tempDir();
    await writeFile(join(root, "файл"), "");
    expect(resolveProject(join(root, "нет"), { home: "/nowhere" })).toBeUndefined();
    expect(resolveProject(join(root, "файл"), { home: "/nowhere" })).toBeUndefined();
    expect(resolveProject(root, { home: root })).toBeUndefined();
    expect(resolveProject(parse(root).root, { home: "/nowhere" })).toBeUndefined();
    expect(resolveProject(tmpdir(), { home: "/nowhere" })).toBeUndefined();
    expect(resolveProject("  ", { home: "/nowhere" })).toBeUndefined();
    expect(
      resolveProject("C:\\Users\\Пётр\\нет-такого", { home: "/nowhere", platform: "linux" }),
    ).toBeUndefined();
  });
});
