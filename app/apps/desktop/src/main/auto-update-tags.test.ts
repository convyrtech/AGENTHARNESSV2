/**
 * Which release tag scheme electron-updater's real GitHubProvider accepts when alphas are
 * GitHub prereleases (`allowPrerelease`). Served from a local atom feed + channel yml.
 *
 * Result (electron-updater 6.8.9): `desktop-v0.1.0-alpha.N` → "No published versions";
 * `v0.1.0-alpha.N` → found. The release workflow must tag `v<version>`.
 */
import { createServer, request, type Server } from "node:http";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

const require = createRequire(import.meta.url);
const updaterOut = dirname(require.resolve("electron-updater"));
const { GitHubProvider } = require(join(updaterOut, "providers", "GitHubProvider.js")) as {
  GitHubProvider: new (
    options: Record<string, unknown>,
    updater: Record<string, unknown>,
    runtime: Record<string, unknown>,
  ) => { getLatestVersion(): Promise<{ tag: string; version: string }> };
};
const runtime = require(require.resolve("builder-util-runtime", { paths: [updaterOut] })) as {
  HttpExecutor: new () => object;
};

// builder-util-runtime's HttpExecutor is abstract over createRequest; plain node http here.
const NodeExecutor = class extends (runtime.HttpExecutor as new () => object) {
  createRequest(options: object, callback: (response: unknown) => void) {
    return request(options, callback);
  }
};

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

async function latestFor(tags: string[], currentVersion: string): Promise<string> {
  const server = createServer((req, res) => {
    if (req.url?.endsWith(".atom")) {
      res.setHeader("content-type", "application/atom+xml");
      res.end(
        `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">${tags
          .map(
            (tag) =>
              `<entry><id>${tag}</id><title>${tag}</title><link rel="alternate" href="https://github.com/convyrtech/AGENTHARNESSV2/releases/tag/${tag}"/><content>x</content></entry>`,
          )
          .join("")}</feed>`,
      );
      return;
    }
    const match = /download\/([^/]+)\/[\w-]+\.yml/.exec(req.url ?? "");
    if (match) {
      const version = match[1]!.replace(/^desktop-v|^v/, "");
      res.end(
        `version: ${version}\nfiles:\n  - url: PRSLOY.exe\n    sha512: abc\n    size: 1\npath: PRSLOY.exe\nsha512: abc\nreleaseDate: '2026-10-25T00:00:00.000Z'\n`,
      );
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const provider = new GitHubProvider(
    {
      provider: "github",
      owner: "convyrtech",
      repo: "AGENTHARNESSV2",
      host: `127.0.0.1:${port}`,
      protocol: "http",
    },
    { allowPrerelease: true, currentVersion, channel: null, fullChangelog: false },
    { executor: new NodeExecutor(), platform: "win32", isUseMultipleRangeRequest: false },
  );
  try {
    const info = await provider.getLatestVersion();
    return `${info.tag} → ${info.version}`;
  } catch (error) {
    return `error: ${(error as { code?: string }).code ?? (error as Error).message}`;
  }
}

describe("electron-updater GitHub tag scheme (prerelease alphas)", () => {
  it("does not see desktop-v* tags", async () => {
    expect(
      await latestFor(["desktop-v0.1.0-alpha.3", "desktop-v0.1.0-alpha.2"], "0.1.0-alpha.2"),
    ).toBe("error: ERR_UPDATER_NO_PUBLISHED_VERSIONS");
  });

  it("finds the newest v<version> prerelease", async () => {
    expect(await latestFor(["v0.1.0-alpha.3", "v0.1.0-alpha.2"], "0.1.0-alpha.2")).toBe(
      "v0.1.0-alpha.3 → 0.1.0-alpha.3",
    );
  });
});
