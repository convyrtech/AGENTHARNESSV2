/**
 * Release artifact policy for electron-updater + GitHub Releases.
 *
 * Keep only what users and the updater need:
 *   installers  — .exe / .dmg / .AppImage / .deb
 *   mac update  — .zip (Squirrel.Mac; dmg is manual install only)
 *   feeds       — latest.yml / latest-mac.yml / latest-linux.yml
 *   blockmaps   — *.blockmap (electron-updater differential / range downloads)
 *
 * Drop noise: builder-debug.yml, unpacked dirs, etc.
 *
 * Usage:
 *   node scripts/release-assets.mjs collect <outDir> <artifactsDir> --platform win|mac|linux [--arch <arch>]
 *   node scripts/release-assets.mjs validate-publish <releaseAssetsDir>
 *   node scripts/release-assets.mjs check-feed <dir> [--version <semver>]   (Windows: latest.yml)
 *   node scripts/release-assets.mjs check-feed <dir> --platform linux [--version <semver>]   (latest-linux.yml)
 *   node scripts/release-assets.mjs list <dir>
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** @typedef {'win' | 'mac' | 'linux'} Platform */

const INSTALLER_EXT = new Set([".exe", ".dmg", ".appimage", ".deb", ".zip"]);
const FEED_NAMES = new Set(["latest.yml", "latest-mac.yml", "latest-linux.yml"]);

/**
 * @param {string} name
 * @returns {boolean}
 */
export function isUsefulReleaseAsset(name) {
  const base = basename(name);
  const lower = base.toLowerCase();
  if (FEED_NAMES.has(lower)) return true;
  // Arch-split mac feeds before merge (latest-mac-arm64.yml, …).
  if (/^latest-mac-.+\.ya?ml$/i.test(base)) return true;
  // Differential update maps (paired with exe/AppImage/zip by electron-updater).
  if (lower.endsWith(".blockmap")) return true;
  if (lower === "builder-debug.yml" || lower === "builder-effective-config.yaml") return false;
  const ext = extensionOf(lower);
  return INSTALLER_EXT.has(ext);
}

/**
 * @param {string} lowerName
 * @returns {string}
 */
function extensionOf(lowerName) {
  if (lowerName.endsWith(".appimage")) return ".appimage";
  const i = lowerName.lastIndexOf(".");
  return i >= 0 ? lowerName.slice(i) : "";
}

/**
 * List top-level files in a directory (non-recursive).
 * @param {string} dir
 * @returns {string[]}
 */
export function listFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((name) => join(dir, name))
    .filter((path) => {
      try {
        return statSync(path).isFile();
      } catch {
        return false;
      }
    });
}

/**
 * @param {string[]} paths
 * @returns {{ installers: string[], feeds: string[], other: string[] }}
 */
export function classifyPaths(paths) {
  /** @type {string[]} */
  const installers = [];
  /** @type {string[]} */
  const feeds = [];
  /** @type {string[]} */
  const other = [];
  for (const path of paths) {
    const base = basename(path);
    const lower = base.toLowerCase();
    if (
      FEED_NAMES.has(lower) ||
      /^latest-mac-.+\.ya?ml$/i.test(base) ||
      /^latest\.ya?ml$/i.test(base)
    ) {
      feeds.push(path);
    } else if (INSTALLER_EXT.has(extensionOf(lower)) || lower.endsWith(".blockmap")) {
      installers.push(path);
    } else {
      other.push(path);
    }
  }
  return { installers, feeds, other };
}

/**
 * Collect useful artifacts from electron-builder output into artifactsDir.
 * Renames latest-mac.yml → latest-mac-<arch>.yml on mac so publish can merge.
 *
 * @param {{
 *   outDir: string,
 *   artifactsDir: string,
 *   platform: Platform,
 *   arch?: string,
 * }} options
 * @returns {{ copied: string[], errors: string[] }}
 */
export function collectReleaseAssets(options) {
  const outDir = resolve(options.outDir);
  const artifactsDir = resolve(options.artifactsDir);
  const platform = options.platform;
  const arch = options.arch?.trim() || "";

  if (!existsSync(outDir)) {
    return { copied: [], errors: [`Package output missing: ${outDir}`] };
  }

  mkdirSync(artifactsDir, { recursive: true });

  const allFiles = listFiles(outDir);
  const useful = allFiles.filter((path) => isUsefulReleaseAsset(basename(path)));
  /** @type {string[]} */
  const copied = [];
  /** @type {string[]} */
  const errors = [];

  for (const src of useful) {
    let destName = basename(src);
    if (platform === "mac" && /^latest-mac\.ya?ml$/i.test(destName) && arch) {
      destName = `latest-mac-${arch}.yml`;
    }
    const dest = join(artifactsDir, destName);
    copyFileSync(src, dest);
    copied.push(destName);
  }

  // Platform gates — fail the job if updater/installer essentials are missing.
  const names = new Set(copied.map((n) => n.toLowerCase()));
  const has = (pred) => copied.some((n) => pred(n.toLowerCase()));

  switch (platform) {
    case "win":
      if (!has((n) => n.endsWith(".exe"))) errors.push("Windows: missing NSIS installer (*.exe)");
      if (!names.has("latest.yml")) errors.push("Windows: missing updater feed latest.yml");
      break;
    case "mac":
      if (!has((n) => n.endsWith(".dmg"))) errors.push("macOS: missing manual installer (*.dmg)");
      if (!has((n) => n.endsWith(".zip"))) {
        errors.push(
          "macOS: missing auto-update archive (*.zip) — electron-updater installs zip, not dmg",
        );
      }
      {
        const hasMacFeed =
          names.has("latest-mac.yml") || copied.some((n) => /^latest-mac-.+\.ya?ml$/i.test(n));
        if (!hasMacFeed) errors.push("macOS: missing updater feed latest-mac.yml");
      }
      break;
    case "linux":
      if (!has((n) => n.endsWith(".appimage"))) errors.push("Linux: missing AppImage (*.AppImage)");
      if (!names.has("latest-linux.yml")) {
        errors.push("Linux: missing updater feed latest-linux.yml");
      }
      break;
    default:
      errors.push(`Unknown platform: ${String(platform)}`);
  }

  if (errors.length > 0) {
    errors.push(`Output dir listing:\n${formatListing(outDir, allFiles)}`);
    errors.push(`Collected: ${copied.length ? copied.sort().join(", ") : "(none)"}`);
  }

  return { copied, errors };
}

/**
 * Validate the final publish directory after multi-platform merge.
 * @param {string} releaseAssetsDir
 * @returns {{ ok: boolean, assets: string[], errors: string[], summary: string }}
 */
export function validatePublishAssets(releaseAssetsDir) {
  const dir = resolve(releaseAssetsDir);
  const files = listFiles(dir).map((p) => basename(p));
  const lower = new Set(files.map((f) => f.toLowerCase()));
  /** @type {string[]} */
  const errors = [];

  const useful = files.filter((f) => isUsefulReleaseAsset(f));
  const noise = files.filter((f) => !isUsefulReleaseAsset(f));
  if (noise.length > 0) {
    errors.push(`Unexpected non-release files (remove or ignore): ${noise.join(", ")}`);
  }

  if (!useful.some((f) => f.toLowerCase().endsWith(".exe"))) {
    errors.push("Missing Windows installer (*.exe)");
  }
  if (!lower.has("latest.yml")) errors.push("Missing Windows feed latest.yml");

  if (!useful.some((f) => f.toLowerCase().endsWith(".dmg"))) {
    errors.push("Missing macOS installer (*.dmg)");
  }
  if (!useful.some((f) => f.toLowerCase().endsWith(".zip"))) {
    errors.push("Missing macOS update archive (*.zip)");
  }
  if (!lower.has("latest-mac.yml")) {
    errors.push("Missing macOS feed latest-mac.yml (merge arm64 + x64 before publish)");
  }
  if (lower.has("latest-mac.yml")) {
    const body = readFileSync(
      join(
        dir,
        files.find((f) => f.toLowerCase() === "latest-mac.yml"),
      ),
      "utf8",
    );
    if (!/\.zip\b/i.test(body)) {
      errors.push("latest-mac.yml must reference at least one .zip (not only .dmg)");
    }
  }

  if (!useful.some((f) => f.toLowerCase().endsWith(".appimage"))) {
    errors.push("Missing Linux AppImage (*.AppImage)");
  }
  if (!lower.has("latest-linux.yml")) errors.push("Missing Linux feed latest-linux.yml");

  // Leftover arch-split feeds must not ship.
  const splitMac = useful.filter((f) => /^latest-mac-.+\.ya?ml$/i.test(f));
  if (splitMac.length > 0) {
    errors.push(`Unmerged arch-split mac feeds still present: ${splitMac.join(", ")}`);
  }

  const summary = [
    "Release assets (electron-updater + installers):",
    ...useful.sort().map((f) => `  - ${f}`),
    "",
    "Feeds: latest.yml (win) · latest-mac.yml (mac) · latest-linux.yml (linux)",
    "mac auto-update uses .zip; .dmg is for manual install only.",
    "Blockmaps enable differential downloads when present (full download still works without them).",
  ].join("\n");

  return { ok: errors.length === 0, assets: useful.sort(), errors, summary };
}

/**
 * @param {string} dir
 * @param {string[]} files
 */
function formatListing(dir, files) {
  if (files.length === 0) {
    try {
      const entries = readdirSync(dir);
      return `  (no files; entries: ${entries.join(", ") || "empty"})`;
    } catch {
      return "  (unreadable)";
    }
  }
  return files
    .map((path) => {
      try {
        const st = statSync(path);
        return `  ${basename(path)}  (${st.size} bytes)`;
      } catch {
        return `  ${basename(path)}`;
      }
    })
    .join("\n");
}

// --- check-feed: latest.yml against the files next to it --------------------------

/** GitHub keeps asset names made of these; anything else (a space, Cyrillic) is renamed on upload. */
const GITHUB_SAFE_NAME = /^[A-Za-z0-9._-]+$/;

/**
 * What electron-updater's GitHubProvider does with a release: reads latest.yml, then downloads
 * `releases/download/<tag>/<files[].url>` (and `<url>.blockmap` for differential downloads) and
 * checks size and sha512. So every url must be an asset of the same release, by that exact name.
 *
 * @param {string} dir  folder with latest.yml, the installer and its blockmap (one release)
 * @param {{ version?: string }} [options]
 */
export function checkWindowsFeed(dir, options = {}) {
  /** @type {string[]} */
  const errors = [];
  const feedPath = join(dir, "latest.yml");
  if (!existsSync(feedPath)) return { ok: false, errors: ["latest.yml missing"], files: [] };
  const yml = readFileSync(feedPath, "utf8");
  const top = (key) => yml.match(new RegExp(`^${key}: *'?([^'\\n]*)'?$`, "m"))?.[1]?.trim();
  /** @type {{ url: string, sha512?: string, size?: number }[]} */
  const files = [];
  for (const block of yml.split(/^ {2}- /m).slice(1)) {
    const field = (key) => block.match(new RegExp(`^\\s*${key}: *(\\S+)`, "m"))?.[1];
    const url = block.match(/^url: *'?(.+?)'?\s*$/m)?.[1];
    if (url) files.push({ url, sha512: field("sha512"), size: Number(field("size")) });
  }

  const version = top("version");
  if (!version) errors.push("latest.yml: no version");
  if (options.version && version !== options.version) {
    errors.push(`latest.yml: version ${version}, expected ${options.version}`);
  }
  if (files.length === 0) errors.push("latest.yml: no files");
  const path = top("path");
  if (path && !files.some((f) => f.url === path)) {
    errors.push(`latest.yml: path ${path} is not among files`);
  }
  for (const f of files) {
    if (!GITHUB_SAFE_NAME.test(f.url)) {
      errors.push(`${f.url}: GitHub would rename this asset (only A-Z a-z 0-9 . _ -)`);
    }
    if (!f.url.toLowerCase().endsWith(".exe")) errors.push(`${f.url}: not a Windows installer`);
    if (version && !f.url.includes(version)) {
      errors.push(`${f.url}: name does not carry version ${version}`);
    }
    const file = join(dir, f.url);
    if (!existsSync(file)) {
      errors.push(`${f.url}: listed in latest.yml but not in the folder`);
      continue;
    }
    const body = readFileSync(file);
    if (f.size !== body.length)
      errors.push(`${f.url}: size ${body.length}, latest.yml says ${f.size}`);
    const sha512 = createHash("sha512").update(body).digest("base64");
    if (f.sha512 !== sha512) errors.push(`${f.url}: sha512 differs from latest.yml`);
    if (!existsSync(`${file}.blockmap`)) errors.push(`${f.url}.blockmap missing`);
  }
  const listed = new Set(files.flatMap((f) => [f.url, `${f.url}.blockmap`]).concat("latest.yml"));
  const extra = listFiles(dir)
    .map((p) => basename(p))
    .filter((name) => !listed.has(name));
  if (extra.length) errors.push(`not referenced by latest.yml: ${extra.join(", ")}`);
  return { ok: errors.length === 0, errors, files: files.map((f) => f.url), version };
}

/**
 * The same for Linux: latest-linux.yml lists the AppImage (its blockmap is embedded in the file,
 * electron-builder writes none beside it) and the .deb (electron-updater's DebUpdater reads the same
 * feed). Every listed file must be in the folder with its size and sha512.
 *
 * @param {string} dir  folder with latest-linux.yml, the AppImage and the .deb (one release)
 * @param {{ version?: string }} [options]
 */
export function checkLinuxFeed(dir, options = {}) {
  /** @type {string[]} */
  const errors = [];
  const feedPath = join(dir, "latest-linux.yml");
  if (!existsSync(feedPath)) {
    return { ok: false, errors: ["latest-linux.yml missing"], files: [] };
  }
  const yml = readFileSync(feedPath, "utf8");
  const top = (key) => yml.match(new RegExp(`^${key}: *'?([^'\\n]*)'?$`, "m"))?.[1]?.trim();
  /** @type {{ url: string, sha512?: string, size?: number }[]} */
  const files = [];
  for (const block of yml.split(/^ {2}- /m).slice(1)) {
    const field = (key) => block.match(new RegExp(`^\\s*${key}: *(\\S+)`, "m"))?.[1];
    const url = block.match(/^url: *'?(.+?)'?\s*$/m)?.[1];
    if (url) files.push({ url, sha512: field("sha512"), size: Number(field("size")) });
  }
  const version = top("version");
  if (!version) errors.push("latest-linux.yml: no version");
  if (options.version && version !== options.version) {
    errors.push(`latest-linux.yml: version ${version}, expected ${options.version}`);
  }
  if (files.length === 0) errors.push("latest-linux.yml: no files");
  for (const f of files) {
    if (!GITHUB_SAFE_NAME.test(f.url)) {
      errors.push(`${f.url}: GitHub would rename this asset (only A-Z a-z 0-9 . _ -)`);
    }
    if (!f.url.endsWith(".AppImage") && !f.url.endsWith(".deb")) {
      errors.push(`${f.url}: neither an AppImage nor a .deb`);
    }
    if (version && !f.url.includes(version)) {
      errors.push(`${f.url}: name does not carry version ${version}`);
    }
    const file = join(dir, f.url);
    if (!existsSync(file)) {
      errors.push(`${f.url}: listed in latest-linux.yml but not in the folder`);
      continue;
    }
    const body = readFileSync(file);
    if (f.size !== body.length) {
      errors.push(`${f.url}: size ${body.length}, latest-linux.yml says ${f.size}`);
    }
    const sha512 = createHash("sha512").update(body).digest("base64");
    if (f.sha512 !== sha512) errors.push(`${f.url}: sha512 differs from latest-linux.yml`);
  }
  if (!files.some((f) => f.url.endsWith(".AppImage"))) errors.push("latest-linux.yml: no AppImage");
  const names = listFiles(dir).map((p) => basename(p));
  if (!names.some((n) => n.endsWith(".deb"))) errors.push("no .deb next to the AppImage");
  const listed = new Set(files.map((f) => f.url).concat("latest-linux.yml"));
  const extra = names.filter((n) => !listed.has(n) && !n.endsWith(".deb"));
  if (extra.length) errors.push(`not referenced by latest-linux.yml: ${extra.join(", ")}`);
  return { ok: errors.length === 0, errors, files: files.map((f) => f.url), version };
}

// --- CLI -----------------------------------------------------------------------

function parseArgs(argv) {
  const args = [...argv];
  const flags = {};
  /** @type {string[]} */
  const positional = [];
  while (args.length) {
    const token = args.shift();
    if (!token) break;
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = args[0];
      if (next && !next.startsWith("--")) {
        flags[key] = args.shift();
      } else {
        flags[key] = "true";
      }
    } else {
      positional.push(token);
    }
  }
  return { positional, flags };
}

function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [command, a, b] = positional;

  if (command === "collect") {
    if (!a || !b || !flags.platform) {
      console.error(
        "Usage: node scripts/release-assets.mjs collect <outDir> <artifactsDir> --platform win|mac|linux [--arch <arch>]",
      );
      process.exit(2);
    }
    const result = collectReleaseAssets({
      outDir: a,
      artifactsDir: b,
      platform: /** @type {Platform} */ (flags.platform),
      ...(flags.arch ? { arch: flags.arch } : {}),
    });
    console.log(
      `Collected ${result.copied.length} asset(s): ${result.copied.sort().join(", ") || "(none)"}`,
    );
    if (result.errors.length) {
      console.error(result.errors.join("\n"));
      process.exit(1);
    }
    return;
  }

  if (command === "validate-publish") {
    if (!a) {
      console.error("Usage: node scripts/release-assets.mjs validate-publish <releaseAssetsDir>");
      process.exit(2);
    }
    const result = validatePublishAssets(a);
    console.log(result.summary);
    if (!result.ok) {
      console.error("\nPublish asset validation failed:");
      for (const err of result.errors) console.error(`  - ${err}`);
      process.exit(1);
    }
    console.log("\nPublish asset validation: ok");
    return;
  }

  if (command === "check-feed") {
    if (!a) {
      console.error(
        "Usage: node scripts/release-assets.mjs check-feed <dir> [--platform linux] [--version <semver>]",
      );
      process.exit(2);
    }
    if (flags.platform === "linux") {
      const linux = checkLinuxFeed(a, { version: flags.version });
      if (!linux.ok) {
        console.error(`latest-linux.yml check failed in ${a}:`);
        for (const err of linux.errors) console.error(`  - ${err}`);
        process.exit(1);
      }
      console.log(`latest-linux.yml ok: ${linux.version} → ${linux.files.join(", ")}`);
      return;
    }
    const result = checkWindowsFeed(a, { version: flags.version });
    if (!result.ok) {
      console.error(`latest.yml check failed in ${a}:`);
      for (const err of result.errors) console.error(`  - ${err}`);
      process.exit(1);
    }
    console.log(`latest.yml ok: ${result.version} → ${result.files.join(", ")} (+ blockmap)`);
    return;
  }

  if (command === "list") {
    if (!a) {
      console.error("Usage: node scripts/release-assets.mjs list <dir>");
      process.exit(2);
    }
    const files = listFiles(a).map((p) => basename(p));
    for (const f of files.sort()) {
      console.log(`${isUsefulReleaseAsset(f) ? "keep" : "drop"}\t${f}`);
    }
    return;
  }

  console.error(`Unknown command: ${command ?? "(none)"}`);
  console.error(
    "Commands: collect | validate-publish | list\nSee scripts/release-assets.mjs header for usage.",
  );
  process.exit(2);
}

const isMain =
  Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) main();
