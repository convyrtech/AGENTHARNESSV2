// Теневой git видит правки, сделанные мимо edit/write: sed -i, генератор, npm init.
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { TurnChanges } from "../src/turn-changes.ts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "prsloy-turn-"));
  dirs.push(root);
  const cwd = join(root, "project");
  execFileSync("mkdir", ["-p", cwd]);
  return { root, cwd };
}

describe("turn changes (shadow git)", () => {
  it("sees a sed -i edit, a generated file and a deletion; ignores node_modules", async () => {
    const { root, cwd } = await workspace();
    await writeFile(join(cwd, "app.js"), "const port = 3000;\nconsole.log(port);\n");
    await writeFile(join(cwd, "old.txt"), "bye\n");
    const changes = new TurnChanges(join(root, "turns"), () => "git");
    changes.begin(cwd);
    await changes.ready();
    execFileSync(
      "sh",
      [
        "-c",
        "sed -i 's/3000/8080/' app.js && echo '{}' > package.json && rm old.txt && mkdir -p node_modules/x && echo 1 > node_modules/x/i.js",
      ],
      { cwd },
    );
    const diff = await changes.current();
    expect(diff?.files.sort()).toEqual(["app.js", "old.txt", "package.json"]);
    expect(diff?.patch).toContain("-const port = 3000;");
    expect(diff?.patch).toContain("+const port = 8080;");
    expect(diff?.patch).not.toContain("node_modules");
  });

  it("nothing changed → empty diff; the user's own .git is untouched", async () => {
    const { root, cwd } = await workspace();
    execFileSync("git", ["init", "-q"], { cwd });
    await writeFile(join(cwd, "a.txt"), "1\n");
    const head = await readFile(join(cwd, ".git", "HEAD"), "utf8");
    const changes = new TurnChanges(join(root, "turns"), () => "git");
    changes.begin(cwd);
    expect(await changes.current()).toEqual({ files: [], patch: "" });
    expect(await readFile(join(cwd, ".git", "HEAD"), "utf8")).toBe(head);
    expect(execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" })).toBe(
      "?? a.txt\n",
    );
  });

  it("no git binary → undefined (unknown), never a throw", async () => {
    const { root, cwd } = await workspace();
    const changes = new TurnChanges(join(root, "turns"), () => join(root, "no-such-git"));
    changes.begin(cwd);
    expect(await changes.current()).toBeUndefined();
  });
});
