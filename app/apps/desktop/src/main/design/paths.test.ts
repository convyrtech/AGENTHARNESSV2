import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import {
  DESIGN_DIR,
  fileUrl,
  insideRoot,
  mimeFor,
  parseDesignUrl,
  toDesignFile,
  workspaceFor,
  workspaceId,
} from "./paths.ts";

function tree() {
  const root = mkdtempSync(join(tmpdir(), "design-paths-"));
  const ws = join(root, "ws");
  mkdirSync(join(ws, "design", "landing"), { recursive: true });
  writeFileSync(join(ws, "design", "landing", "00 moods.png"), "x");
  writeFileSync(join(root, "secret.txt"), "s");
  symlinkSync(join(root, "secret.txt"), join(ws, "link.txt"));
  return { root, ws };
}

describe("workspaceFor", () => {
  it("puts the workspace inside the project, or under the fallback root", () => {
    expect(workspaceFor("/p/shop", "/docs")).toBe(join("/p/shop", DESIGN_DIR));
    expect(workspaceFor(undefined, "/docs")).toBe(join("/docs", DESIGN_DIR));
  });
});

describe("insideRoot", () => {
  it("accepts paths inside and rejects traversal, the root itself and symlinks out", () => {
    const { root, ws } = tree();
    expect(insideRoot(ws, "design/landing/00 moods.png")).toMatch(/00 moods\.png$/);
    expect(insideRoot(ws, join(ws, "design"))).toMatch(/design$/);
    expect(insideRoot(ws, "../secret.txt")).toBeUndefined();
    expect(insideRoot(ws, join(root, "secret.txt"))).toBeUndefined();
    expect(insideRoot(ws, "link.txt")).toBeUndefined();
    expect(insideRoot(ws, ws)).toBeUndefined();
  });
});

describe("design URLs", () => {
  it("round-trips a workspace file without exposing the absolute path", () => {
    const { ws } = tree();
    const file = toDesignFile(ws, join(ws, "design", "landing", "00 moods.png"));
    expect(file).toMatchObject({ path: "design/landing/00 moods.png", kind: "image" });
    expect(file!.url).not.toContain(ws);
    expect(parseDesignUrl(file!.url)).toEqual({
      id: workspaceId(ws),
      rel: "design/landing/00 moods.png",
    });
  });

  it("rejects foreign schemes, bad ids and encoded traversal", () => {
    const id = workspaceId("/x");
    expect(parseDesignUrl("file:///etc/passwd")).toBeUndefined();
    expect(parseDesignUrl("prsloy-design://ws/zz/a.png")).toBeUndefined();
    expect(parseDesignUrl(`prsloy-design://other/${id}/a.png`)).toBeUndefined();
    expect(parseDesignUrl(`prsloy-design://ws/${id}/%2e%2e/secret`)).toBeUndefined();
    expect(parseDesignUrl(`prsloy-design://ws/${id}/a%2F..%2Fb`)).toBeUndefined();
    expect(parseDesignUrl(`prsloy-design://ws/${id}/`)).toBeUndefined();
    expect(fileUrl("/x", "a/b c.png")).toBe(`prsloy-design://ws/${id}/a/b%20c.png`);
  });

  it("drops files outside the workspace", () => {
    const { root, ws } = tree();
    expect(toDesignFile(ws, join(root, "secret.txt"))).toBeUndefined();
  });
});

describe("mimeFor", () => {
  it("serves media with real types and unknowns as octet-stream", () => {
    expect(mimeFor("a.mp4")).toBe("video/mp4");
    expect(mimeFor("a.HTML")).toMatch(/^text\/html/);
    expect(mimeFor("a.exe")).toBe("application/octet-stream");
  });
});
