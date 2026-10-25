/**
 * Assemble apps/desktop/design-bundle/ for electron-builder extraResources (→ Resources/design):
 *
 *   playbooks/site/harness   run.py, judge.py, a6proxy.py, stages.json, pipeline-fixes.patch …
 *   playbooks/site/motion    motion vocabulary + components (run.py copies it into each workspace)
 *   experiments/e8b/etalons  etalon catalogue (no videos)
 *   design-pipeline/         convyrtech/design-pipeline at the commit pinned in design-lock.json,
 *                            pipeline-fixes.patch already applied (+ .pipeline-fixes.sha256 marker,
 *                            so run.py init does not need git on Windows)
 *   wheels/                  optional (--wheels): win_amd64 cp312 wheels for an offline first use
 *
 * design-pipeline is private: give a local clone (DESIGN_PIPELINE_DIR) or a token that can read it
 * (DESIGN_PIPELINE_TOKEN). Without either the bundle is built without it and the tab says so;
 * DESIGN_REQUIRED=1 makes that an error (release builds).
 *
 *   node scripts/fetch-design.mjs [--wheels]
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DESKTOP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(DESKTOP, "..", "..", "..");
const OUT = join(DESKTOP, "design-bundle");
const LOCK = JSON.parse(readFileSync(join(DESKTOP, "design-lock.json"), "utf8"));
const SKIP = new Set(["__pycache__", ".git", "node_modules", ".DS_Store"]);

function copy(src, dst, skip = () => false) {
  cpSync(src, dst, {
    recursive: true,
    filter: (p) => !SKIP.has(basename(p)) && !skip(p),
  });
}

function pipelineSource() {
  if (process.env.DESIGN_PIPELINE_DIR) return { dir: resolve(process.env.DESIGN_PIPELINE_DIR) };
  const token = process.env.DESIGN_PIPELINE_TOKEN;
  if (!token) return undefined;
  const tmp = mkdtempSync(join(tmpdir(), "design-pipeline-"));
  const url = `https://x-access-token:${token}@github.com/${LOCK.pipeline.repo}.git`;
  execFileSync("git", ["init", "-q", tmp]);
  execFileSync("git", ["-C", tmp, "fetch", "-q", "--depth", "1", url, LOCK.pipeline.commit], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  execFileSync("git", ["-C", tmp, "checkout", "-q", "FETCH_HEAD"]);
  return { dir: tmp, cleanup: () => rmSync(tmp, { recursive: true, force: true }) };
}

function bundlePipeline() {
  const src = pipelineSource();
  if (!src) {
    const msg = "design-pipeline not bundled: set DESIGN_PIPELINE_DIR or DESIGN_PIPELINE_TOKEN";
    if (process.env.DESIGN_REQUIRED === "1") throw new Error(msg);
    console.warn(`[fetch-design] ${msg}`);
    return;
  }
  try {
    const head = (() => {
      try {
        return execFileSync("git", ["-C", src.dir, "rev-parse", "HEAD"]).toString().trim();
      } catch {
        return "";
      }
    })();
    if (head && head !== LOCK.pipeline.commit) {
      console.warn(
        `[fetch-design] DESIGN_PIPELINE_DIR is at ${head}, lock pins ${LOCK.pipeline.commit}`,
      );
    }
    const dst = join(OUT, "design-pipeline");
    // examples are big and unused at run time; run.py init skips them too
    copy(src.dir, dst, (p) => basename(p) === "examples" || p.includes(join("tools", "tests")));
    const patch = join(REPO, "playbooks", "site", "harness", "pipeline-fixes.patch");
    // Paths in the patch are relative to the pipeline root. The bundle sits inside this repo's work
    // tree, where git apply would resolve them from the repo top and skip them all: stop discovery.
    execFileSync("git", ["apply", patch], {
      cwd: dst,
      env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(dst) },
    });
    const sha = createHash("sha256").update(readFileSync(patch)).digest("hex");
    writeFileSync(join(dst, ".pipeline-fixes.sha256"), `${sha}\n`);
    writeFileSync(join(dst, ".pinned-commit"), `${head || LOCK.pipeline.commit}\n`);
  } finally {
    src.cleanup?.();
  }
}

function bundleWheels() {
  const python = process.env.PYTHON || (process.platform === "win32" ? "python" : "python3");
  execFileSync(
    python,
    [
      "-m",
      "pip",
      "download",
      "--only-binary=:all:",
      "--platform",
      "win_amd64",
      "--python-version",
      "3.12",
      "--implementation",
      "cp",
      "-d",
      join(OUT, "wheels"),
      ...LOCK.packages,
    ],
    { stdio: "inherit" },
  );
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
copy(join(REPO, "playbooks", "site", "harness"), join(OUT, "playbooks", "site", "harness"));
copy(join(REPO, "playbooks", "site", "motion"), join(OUT, "playbooks", "site", "motion"), (p) =>
  p.endsWith(`${join("motion", "sheets")}`),
);
copy(join(REPO, "experiments", "e8b", "etalons"), join(OUT, "experiments", "e8b", "etalons"), (p) =>
  /\.mp4$|[\\/]frames[^\\/]*$/.test(p),
);
bundlePipeline();
if (process.argv.includes("--wheels")) bundleWheels();
console.log(
  `[fetch-design] ${OUT}${existsSync(join(OUT, "design-pipeline")) ? "" : " (no pipeline)"}`,
);
