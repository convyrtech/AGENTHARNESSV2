/**
 * Window first: managed Node/Python runtimes no longer block the first window.
 *
 * - startSync() (module load, before the window): cheap plan. Already provisioned (second
 *   launch) or a dev tree → configure PATH/env right away, exactly as before.
 * - startBackground() (after the window): first launch unpacks the archives without
 *   blocking (provisionRuntimesAsync), then configures PATH/env and bumps generation().
 *
 * The Agent Host inherits PATH at spawn. A host spawned before the runtimes were ready has
 * a stale env: the supervisor compares its spawn generation with generation() and
 * respawns it before the first turn (see index.ts prompt()).
 */
import {
  applyManagedRuntimeToProcessEnv,
  captureManagedPathBase,
  configureBundledRuntimes,
  type BundledRuntimePrefs,
} from "../bundled-runtimes.ts";
import {
  planProvisionedRuntimes,
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

export class RuntimeBoot {
  readonly #opts: RuntimeBootOptions;
  #plan: ProvisionPlan = { kind: "none" };
  #state: RuntimeBootState = { status: "absent" };
  #generation = 0;
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
      // Host PATH stays the clean base until the background unpack finishes.
      this.#apply(undefined);
      this.#set({ status: this.#plan.kind === "extract" ? "installing" : "absent", done: 0 });
      if (this.#plan.kind === "none") this.#set({ status: "absent" });
    }
    return this.state();
  }

  /** After the window. Idempotent; resolves when ready / failed / nothing to do. */
  startBackground(): Promise<RuntimeBootState> {
    if (this.#plan.kind !== "extract") return Promise.resolve(this.state());
    const plan = this.#plan;
    this.#running ??= (async () => {
      try {
        const layout = await (this.#opts.provision ?? provisionRuntimesAsync)({
          ...this.#provisionOptions(),
          plan,
          onProgress: (done, total) =>
            this.#set({ status: "installing", done, ...(total ? { total } : {}) }),
        });
        this.#layout = layout;
        this.#apply(layout);
        this.#generation += 1;
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

  layout(): ProvisionedRuntimeLayout | undefined {
    return this.#layout;
  }

  /** Bumped when runtimes become ready after startup (hosts spawned earlier are stale). */
  generation(): number {
    return this.#generation;
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
