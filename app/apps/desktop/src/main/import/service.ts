/**
 * #22 I1, main side of bringing chats over from other agents (research/25 §4). Pure of Electron
 * so it is tested with plain folders: the paths come in, the scan result and the run summary go
 * out. The last scan is kept here, and a run takes only keys from it — the renderer cannot make
 * main read a file the scan did not find. Everything is read-only towards the other tools; the
 * only writes are PRSLOY's new chat files and the import journal (packages/session-import).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  candidateKey,
  type ChatCandidate,
  importChats,
  readLedger,
  scanSources,
  type SourceRoots,
  type TargetModel,
} from "@prsloy/session-import";
import type {
  ImportProgress,
  ImportRunResult,
  ImportScanResult,
  ImportSkipReason,
} from "@zeno/contracts";
import {
  PRSLOY_DEFAULT_SPEED_MODE,
  PRSLOY_PROVIDER_ID,
  prsloySpeedModelId,
} from "../../shared/prsloy-config.ts";

export const IMPORT_LEDGER_FILE = "import-ledger.json";
/** Chats listed to the renderer: enough for any screen, small over IPC. */
export const MAX_LISTED_CHATS = 500;

export type ImportPaths = {
  roots: SourceRoots;
  home: string;
  /** PRSLOY's chat folder (PI_CODING_AGENT_SESSION_DIR). */
  sessionDir: string;
  /** PRSLOY's agent folder, for the default model in settings.json. */
  agentDir: string;
  /** `<userData>/prsloy/import-ledger.json`. */
  ledgerPath: string;
  /** `<userData>/prsloy/state.json`: the models the gateway served at the last check. */
  statePath: string;
};

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Model ids the gateway's `/v1/models` listed (prsloy/context.ts keeps them in state.json). */
export function servedModels(statePath: string): string[] | undefined {
  const models = readJson(statePath)?.models;
  const ids = models && typeof models === "object" ? (models as { ids?: unknown }).ids : undefined;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : undefined;
}

/**
 * The model imported chats continue on: the one PRSLOY's settings name, else the default of the
 * models the gateway serves (so the first turn does not ask for one it dropped).
 */
export function importTargetModel(agentDir: string, served?: readonly string[]): TargetModel {
  const settings = readJson(join(agentDir, "settings.json"));
  if (typeof settings?.defaultProvider === "string" && typeof settings.defaultModel === "string") {
    return { provider: settings.defaultProvider, modelId: settings.defaultModel };
  }
  return {
    provider: PRSLOY_PROVIDER_ID,
    modelId: prsloySpeedModelId(PRSLOY_DEFAULT_SPEED_MODE, served?.length ? served : undefined),
  };
}

export class SessionImportService {
  #candidates = new Map<string, ChatCandidate>();
  readonly #paths: () => ImportPaths;

  constructor(paths: () => ImportPaths) {
    this.#paths = paths;
  }

  async scan(now = Date.now()): Promise<ImportScanResult> {
    const paths = this.#paths();
    const result = await scanSources({
      roots: paths.roots,
      ledger: await readLedger(paths.ledgerPath),
      now,
    });
    this.#candidates = new Map(result.candidates.map((c) => [candidateKey(c), c]));
    return {
      counts: result.counts,
      chats: result.candidates.slice(0, MAX_LISTED_CHATS).map((c) => ({
        key: candidateKey(c),
        tool: c.tool,
        title: c.title,
        project: c.cwd,
        updatedAt: c.updatedAt,
        alreadyImported: c.alreadyImported === true,
      })),
      selected: result.selected,
      unreadable: [...new Set(result.skipped.map((skip) => skip.tool))],
    };
  }

  /** Imports the chats behind the keys of the last scan; other keys are ignored. */
  async run(
    keys: unknown,
    onProgress?: (progress: ImportProgress) => void,
  ): Promise<ImportRunResult> {
    const wanted = Array.isArray(keys)
      ? keys.filter((k): k is string => typeof k === "string")
      : [];
    const candidates = [...new Set(wanted)]
      .map((key) => this.#candidates.get(key))
      .filter((c): c is ChatCandidate => c !== undefined);
    const paths = this.#paths();
    const results = await importChats({
      candidates,
      roots: paths.roots,
      home: paths.home,
      sessionDir: paths.sessionDir,
      ledgerPath: paths.ledgerPath,
      target: importTargetModel(paths.agentDir, servedModels(paths.statePath)),
      onProgress: (done, total) => onProgress?.({ done, total }),
    });
    const skipped: Partial<Record<ImportSkipReason, number>> = {};
    const perProject = new Map<string, number>();
    let imported = 0;
    for (const result of results) {
      if (result.status === "imported") {
        imported += 1;
        perProject.set(result.cwd, (perProject.get(result.cwd) ?? 0) + 1);
      } else {
        skipped[result.reason] = (skipped[result.reason] ?? 0) + 1;
      }
    }
    const projects = [...perProject.entries()].sort((a, b) => b[1] - a[1]).map(([path]) => path);
    return { imported, skipped, projects };
  }
}
