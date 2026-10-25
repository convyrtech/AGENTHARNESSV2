import { describe, expect, it } from "vite-plus/test";
import {
  MAX_SKIPPED_RELEASES,
  dropAtomEntries,
  missingChannelFileTag,
  skippingGitHubProvider,
} from "./update-provider.ts";

const entry = (tag: string) =>
  `<entry><link rel="alternate" href="https://github.com/o/r/releases/tag/${tag}"/><title>${tag}</title></entry>\n`;
const atom = (...tags: string[]) => `<feed>\n${tags.map(entry).join("")}</feed>`;

function channelFileError(tag: string) {
  return Object.assign(
    new Error(
      `Cannot find latest.yml in the latest release artifacts (http://127.0.0.1:1/o/r/releases/download/${tag}/latest.yml): HttpError: 404`,
    ),
    { code: "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND" },
  );
}

describe("missingChannelFileTag", () => {
  it("reads the tag of a release without latest.yml / alpha.yml", () => {
    expect(missingChannelFileTag(channelFileError("v0.1.0-alpha.92"))).toBe("v0.1.0-alpha.92");
  });

  it("ignores every other error", () => {
    expect(missingChannelFileTag(new Error("net::ERR_INTERNET_DISCONNECTED"))).toBeUndefined();
    expect(
      missingChannelFileTag(
        Object.assign(new Error("x"), { code: "ERR_UPDATER_NO_PUBLISHED_VERSIONS" }),
      ),
    ).toBeUndefined();
    expect(missingChannelFileTag(undefined)).toBeUndefined();
  });
});

describe("dropAtomEntries", () => {
  it("removes only the given tags", () => {
    const xml = atom("v0.1.0-alpha.92", "v0.1.0-alpha.91");
    const out = dropAtomEntries(xml, new Set(["v0.1.0-alpha.92"]));
    expect(out).not.toContain("alpha.92");
    expect(out).toContain("/tag/v0.1.0-alpha.91");
    expect(dropAtomEntries(xml, new Set())).toBe(xml);
  });
});

describe("skippingGitHubProvider", () => {
  /** Stand-in for GitHubProvider: first entry of the atom wins, 404 if it has no files. */
  class FakeGitHubProvider {
    atomRequests = 0;
    constructor(
      readonly feed: string,
      readonly withFiles: Set<string>,
    ) {}
    async httpRequest(url: URL): Promise<string | null> {
      if (url.pathname.endsWith(".atom")) this.atomRequests++;
      return this.feed;
    }
    async getLatestVersion(): Promise<unknown> {
      const xml = await this.httpRequest(new URL("http://h/o/r/releases.atom"));
      const tag = /\/tag\/([^/"]+)"/.exec(xml ?? "")?.[1];
      if (!tag)
        throw Object.assign(new Error("none"), { code: "ERR_UPDATER_NO_PUBLISHED_VERSIONS" });
      if (!this.withFiles.has(tag)) throw channelFileError(tag);
      return { tag };
    }
  }
  const Skipping = skippingGitHubProvider(FakeGitHubProvider);

  it("falls back to the newest release that has its files", async () => {
    const p = new Skipping(
      atom("v0.1.0-alpha.93", "v0.1.0-alpha.92", "v0.1.0-alpha.91"),
      new Set(["v0.1.0-alpha.91"]),
    );
    await expect(p.getLatestVersion()).resolves.toEqual({ tag: "v0.1.0-alpha.91" });
    expect(p.atomRequests).toBe(3);
  });

  it("returns the first release when it is complete", async () => {
    const p = new Skipping(atom("v0.1.0-alpha.92"), new Set(["v0.1.0-alpha.92"]));
    await expect(p.getLatestVersion()).resolves.toEqual({ tag: "v0.1.0-alpha.92" });
    expect(p.atomRequests).toBe(1);
  });

  it("gives up after a bounded number of empty releases", async () => {
    const tags = Array.from(
      { length: MAX_SKIPPED_RELEASES + 2 },
      (_, i) => `v0.1.0-alpha.${90 + i}`,
    );
    const p = new Skipping(atom(...tags), new Set());
    await expect(p.getLatestVersion()).rejects.toMatchObject({
      code: "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND",
    });
    expect(p.atomRequests).toBe(MAX_SKIPPED_RELEASES + 1);
  });

  it("does not swallow other errors", async () => {
    const p = new Skipping("<feed></feed>", new Set());
    await expect(p.getLatestVersion()).rejects.toMatchObject({
      code: "ERR_UPDATER_NO_PUBLISHED_VERSIONS",
    });
  });
});
