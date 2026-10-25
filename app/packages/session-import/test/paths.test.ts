import { describe, expect, it } from "vite-plus/test";
import { join } from "node:path";
import { homeDir, sourceRoots } from "../src/paths.ts";

describe("paths", () => {
  it("finds the Windows home from USERPROFILE, then HOMEDRIVE+HOMEPATH", () => {
    expect(homeDir({ USERPROFILE: "C:\\Users\\Пётр" }, "win32")).toBe("C:\\Users\\Пётр");
    expect(homeDir({ HOMEDRIVE: "D:", HOMEPATH: "\\Users\\Анна" }, "win32")).toBe(
      "D:\\Users\\Анна",
    );
    expect(homeDir({ HOME: "/home/anna" }, "linux")).toBe("/home/anna");
  });

  it("uses each tool's own override, but never Pi's", () => {
    const roots = sourceRoots(
      {
        HOME: "/h",
        CLAUDE_CONFIG_DIR: "/c",
        CODEX_HOME: "/x",
        PI_CODING_AGENT_DIR: "/ours",
        PI_CODING_AGENT_SESSION_DIR: "/ours/s",
      },
      "linux",
    );
    expect(roots).toEqual({
      claudeProjects: join("/c", "projects"),
      codexHome: "/x",
      piSessions: join("/h", ".pi", "agent", "sessions"),
      opencodeData: join("/h", ".local", "share", "opencode"),
      geminiDir: join("/h", ".gemini"),
      cursorDir: join("/h", ".cursor"),
    });
    expect(sourceRoots({ HOME: "/h", GEMINI_CLI_HOME: "/g" }, "linux").geminiDir).toBe(
      join("/g", ".gemini"),
    );
    expect(
      sourceRoots({ USERPROFILE: "C:\\Users\\Пётр", XDG_DATA_HOME: "D:\\данные" }, "win32"),
    ).toMatchObject({ opencodeData: join("D:\\данные", "opencode") });
    expect(sourceRoots({ HOME: "/h", OPENCODE_DB: "/x/my.db" }, "linux").opencodeDb).toBe(
      "/x/my.db",
    );
    expect(sourceRoots({ HOME: "/h" }, "linux").claudeProjects).toBe(
      join("/h", ".claude", "projects"),
    );
  });
});
