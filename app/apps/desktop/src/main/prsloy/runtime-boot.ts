/**
 * Window first: managed Node/Python runtimes no longer block the first window.
 *
 * - startSync() (module load, before the window): cheap plan. Already provisioned (second
 *   launch) or a dev tree → configure PATH/env right away, exactly as before.
 * - startBackground() (after the window): first launch unpacks the archives without
 *   blocking (provisionRuntimesAsync), then configures PATH/env and bumps generation().
 *
 * The Agent Host inherits PATH at spawn, and may spawn while the unpack still runs. So
 * during the unpack the env already carries the final runtime locations (they are fixed
 * paths under userData): a host spawned early needs no respawn, and the first turn waits
 * for the unpack anyway (prepareTurn).
 */
import { join } from "node:path";
import {
  applyManagedRuntimeToProcessEnv,
  getActiveBundledBinDirs,
  captureManagedPathBase,
  configureBundledRuntimes,
  type BundledRuntimePrefs,
} from "../bundled-runtimes.ts";
import { augmentEnvPath } from "../shell-path.ts";
import {
  npmPrefixDir,
  planProvisionedRuntimes,
  pythonVenvDir,
  userRuntimesRoot,
  provisionRuntimesAsync,
  type ProvisionedRuntimeLayout,
  type ProvisionPlan,
} from "../runtime-provision.ts";

export type RuntimeBootStatus = "absent" | "installing" | "ready" | "failed";

export type RuntimeBootState = {
  status: RuntimeBootStatus;
  /** Files unpacked so far / expected (first launch only). */
  done?: number;
  total?: number;
  error?: string;
};

export type RuntimeBootOptions = {
  userDataPath: string;
  resourcesPath?: string | undefined;
  mainModuleUrl?: string | undefined;
  prefs: BundledRuntimePrefs;
  env?: NodeJS.ProcessEnv;
  /** Injectable for tests. */
  plan?: (options: Parameters<typeof planProvisionedRuntimes>[0]) => ProvisionPlan;
  provision?: typeof provisionRuntimesAsync;
};

/**
 * PATH dirs + env the unpacked runtimes will have, in getActiveBundledBinDirs() order
 * (npm prefix, venv, node, python). VIRTUAL_ENV is left out: the venv may fail to
 * build, and a venv python on PATH works without it.
 */
export function expectedRuntimeEnv(options: {
  userDataPath: string;
  prefs: BundledRuntimePrefs;
  platform?: NodeJS.Platform;
}): { binDirs: string[]; env: Record<string, string> } {
  const win = (options.platform ?? process.platform) === "win32";
  const root = userRuntimesRoot(options.userDataPath);
  const npmPrefix = npmPrefixDir(options.userDataPath);
  const venv = pythonVenvDir(options.userDataPath);
  const binDirs: string[] = [];
  const env: Record<string, string> = {};
  if (options.prefs.useBundledNode) {
    binDirs.push(win ? npmPrefix : join(npmPrefix, "bin"));
    env.NPM_CONFIG_PREFIX = npmPrefix;
    env.npm_config_prefix = npmPrefix;
    env.NODE_BINARY = win ? join(root, "node", "node.exe") : join(root, "node", "bin", "node");
  }
  if (options.prefs.useBundledPython) binDirs.push(join(venv, win ? "Scripts" : "bin"));
  if (options.prefs.useBundledNode)
    binDirs.push(win ? join(root, "node") : join(root, "node", "bin"));
  if (options.prefs.useBundledPython) {
    binDirs.push(win ? join(root, "python") : join(root, "python", "bin"));
  }
  return { binDirs, env };
}

/** Test hook (test commands only): stretch the unpack to reproduce slow Windows disks. */
async function testUnpackDelay(env: NodeJS.ProcessEnv): Promise<void> {
  const ms = Number(env.PRSLOY_TEST_UNPACK_DELAY_MS);
  if (env.ZENO_ENABLE_TEST_COMMANDS !== "1" || !Number.isFinite(ms) || ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, Math.min(ms, 120_000)));
}

export class RuntimeBoot {
  readonly #opts: RuntimeBootOptions;
  #plan: ProvisionPlan = { kind: "none" };
  #state: RuntimeBootState = { status: "absent" };
  #running: Promise<RuntimeBootState> | undefined;
  #layout: ProvisionedRuntimeLayout | undefined;
  readonly #listeners = new Set<(state: RuntimeBootState) => void>();

  constructor(options: RuntimeBootOptions) {
    this.#opts = options;
  }

  #provisionOptions() {
    return {
      userDataPath: this.#opts.userDataPath,
      ...(this.#opts.resourcesPath ? { resourcesPath: this.#opts.resourcesPath } : {}),
      ...(this.#opts.mainModuleUrl ? { mainModuleUrl: this.#opts.mainModuleUrl } : {}),
    };
  }

  #set(state: RuntimeBootState): void {
    this.#state = state;
    for (const listener of this.#listeners) listener({ ...state });
  }

  #apply(layout: ProvisionedRuntimeLayout | undefined): void {
    const env = this.#opts.env ?? process.env;
    configureBundledRuntimes({
      roots: layout?.roots,
      prefs: this.#opts.prefs,
      ...(layout
        ? {
            isolation: {
              npmPrefix: layout.npmPrefix,
              pythonVenv: layout.pythonVenv,
              source: layout.source,
            },
          }
        : {}),
    });
    applyManagedRuntimeToProcessEnv(env);
  }

  /** Before the window. Never extracts. */
  startSync(): RuntimeBootState {
    captureManagedPathBase(this.#opts.env ?? process.env);
    try {
      this.#plan = (this.#opts.plan ?? planProvisionedRuntimes)(this.#provisionOptions());
    } catch (error) {
      console.warn("[prsloy] runtime plan failed:", error);
      this.#plan = { kind: "none" };
    }
    if (this.#plan.kind === "ready") {
      this.#layout = this.#plan.layout;
      this.#apply(this.#layout);
      this.#set({ status: "ready" });
    } else {
      this.#apply(undefined);
      if (this.#plan.kind === "extract") {
        // Point PATH at where the runtimes are about to land (see the header).
        const env = this.#opts.env ?? process.env;
        const expected = expectedRuntimeEnv({
          userDataPath: this.#opts.userDataPath,
          prefs: this.#opts.prefs,
        });
        const next = augmentEnvPath(env, expected.binDirs);
        if (next.PATH) env.PATH = next.PATH;
        if (process.platform === "win32" && next.Path) env.Path = next.Path;
        Object.assign(env, expected.env);
        this.#set({ status: "installing", done: 0 });
      } else {
        this.#set({ status: "absent" });
      }
    }
    return this.state();
  }

  /** After the window. Idempotent; resolves when ready / failed / nothing to do. */
  startBackground(): Promise<RuntimeBootState> {
    if (this.#plan.kind !== "extract") return Promise.resolve(this.state());
    const plan = this.#plan;
    this.#running ??= (async () => {
      try {
        await testUnpackDelay(this.#opts.env ?? process.env);
        const layout = await (this.#opts.provision ?? provisionRuntimesAsync)({
          ...this.#provisionOptions(),
          plan,
          onProgress: (done, total) =>
            this.#set({ status: "installing", done, ...(total ? { total } : {}) }),
        });
        this.#layout = layout;
        this.#apply(layout);
        this.#set(layout ? { status: "ready" } : { status: "failed", error: "runtimes missing" });
      } catch (error) {
        this.#set({
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return this.state();
    })();
    return this.#running;
  }

  state(): RuntimeBootState {
    return { ...this.#state };
  }

  /**
   * Managed bin dirs to put first on a spawned host's PATH (ahead of /usr/local/bin,
   * Program Files\nodejs and the like): the final ones while the unpack runs.
   */
  binDirs(): string[] {
    if (this.#state.status !== "installing") return getActiveBundledBinDirs();
    return expectedRuntimeEnv({ userDataPath: this.#opts.userDataPath, prefs: this.#opts.prefs })
      .binDirs;
  }

  layout(): ProvisionedRuntimeLayout | undefined {
    return this.#layout;
  }

  onChange(listener: (state: RuntimeBootState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Wait (bounded) while installing. True when usable. */
  async whenReady(timeoutMs: number): Promise<boolean> {
    if (this.#state.status !== "installing") return this.#state.status === "ready";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      this.startBackground(),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    return outcome?.status === "ready";
  }
}
