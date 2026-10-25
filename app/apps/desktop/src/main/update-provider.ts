/**
 * GitHub releases feed that skips a release without update files.
 *
 * electron-updater's GitHubProvider (6.8.9) takes the first semver tag of `releases.atom` and
 * stops with ERR_UPDATER_CHANNEL_FILE_NOT_FOUND when that release has no `latest.yml` yet (a
 * release published before CI attached its files, or a failed build). Until a newer complete
 * release exists, nobody gets updates. This subclass notes such a tag and re-reads the feed
 * without it, so the newest release that has its files wins. Everything else — channel files,
 * download URLs, ranges — stays GitHubProvider's own code.
 */

/** At most this many empty releases are skipped per check. */
export const MAX_SKIPPED_RELEASES = 3;

/** The release tag of a «channel file not found» error, from its URL; undefined otherwise. */
export function missingChannelFileTag(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (code !== "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND" || typeof message !== "string") {
    return undefined;
  }
  const match = /\/releases\/download\/([^/\s]+)\/[^/\s)]+\.ya?ml\b/.exec(message);
  return match ? decodeURIComponent(match[1]!) : undefined;
}

/** `releases.atom` without the entries of the given tags. */
export function dropAtomEntries(xml: string, tags: ReadonlySet<string>): string {
  if (tags.size === 0) return xml;
  return xml.replace(/<entry>[\s\S]*?<\/entry>\s*/g, (entry) => {
    const tag = /\/tag\/([^/"]+)"/.exec(entry)?.[1];
    return tag && tags.has(decodeURIComponent(tag)) ? "" : entry;
  });
}

type GitHubProviderLike = {
  getLatestVersion(): Promise<unknown>;
  httpRequest(url: URL, headers?: unknown, cancellationToken?: unknown): Promise<string | null>;
};

type ProviderClass = new (...args: never[]) => GitHubProviderLike;

/** Subclass of electron-updater's GitHubProvider that skips releases without update files. */
export function skippingGitHubProvider<T extends ProviderClass>(Base: T): T {
  // @ts-expect-error -- mixin over a class with an unknown constructor signature
  return class SkippingGitHubProvider extends Base {
    readonly skippedTags = new Set<string>();

    override async getLatestVersion(): Promise<unknown> {
      // Every check starts over: a release that got its files since is no longer skipped.
      this.skippedTags.clear();
      for (let attempt = 0; ; attempt++) {
        try {
          return await super.getLatestVersion();
        } catch (error) {
          const tag = missingChannelFileTag(error);
          if (!tag || this.skippedTags.has(tag) || attempt >= MAX_SKIPPED_RELEASES) throw error;
          console.warn(
            `[zeno] update: release ${tag} has no update files yet, trying an older one`,
          );
          this.skippedTags.add(tag);
        }
      }
    }

    override async httpRequest(
      url: URL,
      headers?: unknown,
      cancellationToken?: unknown,
    ): Promise<string | null> {
      const body = await super.httpRequest(url, headers, cancellationToken);
      if (body == null || this.skippedTags.size === 0 || !url.pathname.endsWith(".atom")) {
        return body;
      }
      return dropAtomEntries(body, this.skippedTags);
    }
  };
}
