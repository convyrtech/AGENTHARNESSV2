import { describe, expect, it } from "vite-plus/test";
import {
  contentMediaKind,
  inlineCodeFileHref,
  contentSourceUrl,
  formatFileLinkLabel,
  formatWorkspaceRelativePath,
  parseContentLink,
} from "./content-rendering.ts";

describe("conversation content targets", () => {
  it("classifies video sources independently from images", () => {
    expect(contentMediaKind("/tmp/demo.mp4?download=1")).toBe("video");
    expect(contentMediaKind("/tmp/screenshot.webp")).toBe("image");
  });

  it("parses local file line links and safe external URLs", () => {
    expect(parseContentLink("/tmp/app.ts:42:7")).toEqual({
      kind: "file",
      path: "/tmp/app.ts",
      line: 42,
      column: 7,
    });
    expect(parseContentLink("src/app.ts#L12", "/work/project")).toEqual({
      kind: "file",
      path: "/work/project/src/app.ts",
      line: 12,
    });
    expect(parseContentLink("https://example.com/docs")).toEqual({
      kind: "external",
      href: "https://example.com/docs",
    });
    expect(parseContentLink("javascript:alert(1)")).toEqual({ kind: "blocked" });
  });

  it("converts local media paths to encoded file URLs", () => {
    expect(contentSourceUrl("/tmp/design preview.png")).toBe("file:///tmp/design%20preview.png");
  });

  it("shortens absolute paths under the workspace for session display", () => {
    expect(formatWorkspaceRelativePath("/work/project/src/app.ts", "/work/project")).toBe(
      "src/app.ts",
    );
    expect(formatWorkspaceRelativePath("src/app.ts", "/work/project")).toBe("src/app.ts");
    expect(formatWorkspaceRelativePath("/tmp/outside.ts", "/work/project")).toBe("outside.ts");
    expect(formatFileLinkLabel("app.ts", "/work/project/src/app.ts", "/work/project")).toBe(
      "src/app.ts",
    );
    expect(formatFileLinkLabel("Fixture file", "/work/project/fixture.txt", "/work/project")).toBe(
      "Fixture file",
    );
  });
});

describe("inlineCodeFileHref", () => {
  it("turns file names in inline code into open targets", () => {
    expect(inlineCodeFileHref("index.html", "/home/u/site")).toBe("index.html");
    expect(inlineCodeFileHref("site/landing/index.html:12", "/home/u/p")).toBe(
      "site/landing/index.html:12",
    );
    expect(inlineCodeFileHref("/home/u/p/logo.png")).toBe("/home/u/p/logo.png");
    expect(inlineCodeFileHref("C:\\Users\\u\\site\\index.html")).toBe(
      "C:\\Users\\u\\site\\index.html",
    );
  });

  it("leaves code, commands and URLs alone", () => {
    expect(inlineCodeFileHref("npm test", "/p")).toBeUndefined();
    expect(inlineCodeFileHref("const a = 1", "/p")).toBeUndefined();
    expect(inlineCodeFileHref("https://example.com/a.html", "/p")).toBeUndefined();
    expect(inlineCodeFileHref("README", "/p")).toBeUndefined();
    expect(inlineCodeFileHref("index.html")).toBeUndefined();
  });
});
