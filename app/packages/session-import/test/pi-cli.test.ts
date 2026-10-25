import { afterEach, describe, expect, it } from "vite-plus/test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { piCliCandidate, piCliFiles, readPiCliSession } from "../src/adapters/pi-cli.ts";
import { cleanTemp, PI_DIR, PI_FILE, tempDir, WINDOWS_CWD } from "./helpers.ts";

afterEach(cleanTemp);

describe("Pi CLI adapter", () => {
  it("finds sessions one folder deep", async () => {
    expect(await piCliFiles(PI_DIR)).toEqual([PI_FILE]);
    expect(await piCliFiles(join(PI_DIR, "нет"))).toEqual([]);
  });

  it("reads project and name from the session itself", async () => {
    expect(await piCliCandidate(PI_FILE)).toMatchObject({
      tool: "pi-cli",
      sourceId: "3e5c7a99-6b8f-4d0e-b2a1-5f4d3c6e7a89",
      cwd: WINDOWS_CWD.pi,
      title: "Статья про чай",
    });
  });

  it("copies every entry, the whole tree, with secrets hidden", async () => {
    const copy = await readPiCliSession(PI_FILE);
    expect(copy?.entries).toHaveLength(5);
    expect(copy?.header.cwd).toBe(WINDOWS_CWD.pi);
    expect(copy?.title).toBe("Статья про чай");

    const dir = await tempDir();
    const file = join(dir, "s.jsonl");
    const token = `ghp_${"Ab1".repeat(12)}`;
    await writeFile(
      file,
      [
        { type: "session", version: 3, id: "s", timestamp: "2026-10-01T10:00:00.000Z", cwd: "/p" },
        {
          type: "message",
          id: "a",
          parentId: null,
          timestamp: "2026-10-01T10:00:00.000Z",
          message: { role: "user", content: [{ type: "text", text: `токен ${token}` }] },
        },
      ]
        .map((l) => JSON.stringify(l))
        .join("\n"),
    );
    const scrubbed = await readPiCliSession(file);
    expect(JSON.stringify(scrubbed)).not.toContain(token);
    expect(scrubbed?.secrets).toBe(1);
  });

  it("refuses a file that is not a Pi session", async () => {
    const dir = await tempDir();
    const file = join(dir, "x.jsonl");
    await writeFile(file, JSON.stringify({ type: "user", cwd: "/p" }));
    expect(await readPiCliSession(file)).toBeUndefined();
    expect(await piCliCandidate(file)).toBeUndefined();
  });
});
