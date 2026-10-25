import { describe, expect, it } from "vite-plus/test";
import { importOriginKey } from "./import-origin.ts";

describe("importOriginKey", () => {
  it("meets Windows paths that differ in slashes and case", () => {
    const a = importOriginKey(
      "C:\\Users\\Пётр\\AppData\\Roaming\\PRSLOY\\agent\\sessions\\x.jsonl",
      true,
    );
    const b = importOriginKey("c:/users/пётр//appdata/roaming/prsloy/agent/sessions/X.jsonl", true);
    expect(a).toBe(b);
  });

  it("keeps case where the file system does", () => {
    expect(importOriginKey("/home/u/s/A.jsonl", false)).not.toBe(
      importOriginKey("/home/u/s/a.jsonl", false),
    );
    expect(importOriginKey("/home/u//s/", false)).toBe("/home/u/s");
  });
});
