/**
 * The composer's project list (#56): the same folder in two spellings must not appear twice.
 */
import { describe, expect, it } from "vite-plus/test";
import { projectPathKey, uniqueProjectPaths } from "./composer-projects.ts";

describe("projectPathKey", () => {
  it("folds backslashes and a trailing slash to one key", () => {
    expect(projectPathKey("C:\\Users\\me\\proj\\")).toBe("C:/Users/me/proj");
    expect(projectPathKey("/home/me/proj/")).toBe("/home/me/proj");
  });
});

describe("uniqueProjectPaths", () => {
  it("puts the open folder first and keeps each folder once", () => {
    expect(uniqueProjectPaths("/a", ["/b", "/a", "/c"])).toEqual(["/a", "/b", "/c"]);
  });

  it("drops a recent that is the open folder written another way", () => {
    expect(uniqueProjectPaths("C:\\proj", ["C:/proj/", "C:/proj", "D:/other"])).toEqual([
      "C:\\proj",
      "D:/other",
    ]);
  });

  it("works without an open folder and keeps the original spelling", () => {
    expect(uniqueProjectPaths(undefined, ["/x/", "/x"])).toEqual(["/x/"]);
    expect(uniqueProjectPaths(undefined, [])).toEqual([]);
  });
});
