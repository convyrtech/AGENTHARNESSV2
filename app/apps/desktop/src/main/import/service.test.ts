import { afterEach, describe, expect, it } from "vite-plus/test";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { cleanTemp, fakeMachine } from "../../../../../packages/session-import/test/helpers.ts";
import { PRSLOY_PROVIDER_ID } from "../../shared/prsloy-config.ts";
import {
  importTargetModel,
  MAX_LISTED_CHATS,
  servedModels,
  SessionImportService,
} from "./service.ts";

afterEach(cleanTemp);

const NOW = Date.UTC(2026, 9, 25);

async function service() {
  const machine = await fakeMachine();
  const agentDir = join(machine.root, "agent");
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({ defaultProvider: "prsloy", defaultModel: "deepseek-v4.1-flash-1017" }),
  );
  const paths = { ...machine, agentDir, statePath: join(machine.root, "prsloy", "state.json") };
  return { machine, svc: new SessionImportService(() => paths) };
}

describe("SessionImportService", () => {
  it("lists what the scan found, with counts and default ticks", async () => {
    const { svc } = await service();
    const scan = await svc.scan(NOW);
    expect(scan.counts.codex).toEqual({ chats: 1, projects: 1, recent: 1 });
    expect(scan.chats).toHaveLength(5);
    expect(scan.selected).toHaveLength(5);
    expect(scan.chats[0]).toMatchObject({ alreadyImported: false });
    expect(Object.keys(scan.chats[0]!).sort()).toEqual(
      ["alreadyImported", "key", "project", "title", "tool", "updatedAt"].sort(),
    );
    expect(MAX_LISTED_CHATS).toBe(500);
  });

  it("imports only chats from the last scan, reports progress and projects", async () => {
    const { machine, svc } = await service();
    const scan = await svc.scan(NOW);
    const progress: number[] = [];
    const result = await svc.run(
      [...scan.selected, "claude-code:not-scanned", "/etc/passwd", 42, scan.selected[0]],
      (p) => progress.push(p.done),
    );
    expect(result.imported).toBe(5);
    expect(result.skipped).toEqual({});
    expect(progress).toEqual([1, 2, 3, 4, 5]);
    // the Claude Code project has three chats, so it comes first
    expect(result.projects[0]).toBe(realpathSync.native(machine.projects.claude));
    expect(result.projects).toHaveLength(3);
    const files = await readdir(machine.sessionDir);
    expect(files).toHaveLength(5);

    const again = await svc.run(scan.selected);
    expect(again).toEqual({ imported: 0, skipped: { already: 5 }, projects: [] });
    expect((await svc.scan(NOW)).chats.every((c) => c.alreadyImported)).toBe(true);
  });

  it("ignores anything that is not a list of keys", async () => {
    const { svc } = await service();
    await svc.scan(NOW);
    expect(await svc.run("claude-code:x")).toEqual({ imported: 0, skipped: {}, projects: [] });
    expect(await svc.run(undefined)).toEqual({ imported: 0, skipped: {}, projects: [] });
  });

  it("continues imported chats on PRSLOY's model", async () => {
    const { machine } = await service();
    expect(importTargetModel(join(machine.root, "agent"))).toEqual({
      provider: "prsloy",
      modelId: "deepseek-v4.1-flash-1017",
    });
    expect(importTargetModel(join(machine.root, "нет")).provider).toBe(PRSLOY_PROVIDER_ID);
  });

  it("without settings picks a model the gateway still serves", async () => {
    const { machine } = await service();
    const statePath = join(machine.root, "prsloy", "state.json");
    expect(servedModels(statePath)).toBeUndefined();
    await mkdir(join(machine.root, "prsloy"), { recursive: true });
    await writeFile(statePath, JSON.stringify({ models: { ids: ["kimi-k3.1-pro", 7] } }));
    expect(servedModels(statePath)).toEqual(["kimi-k3.1-pro"]);
    expect(importTargetModel(join(machine.root, "нет"), ["kimi-k3.1-pro"])).toEqual({
      provider: PRSLOY_PROVIDER_ID,
      modelId: "kimi-k3.1-pro",
    });
  });

  it("reports a source it could not read instead of failing the scan", async () => {
    const { machine, svc } = await service();
    expect((await svc.scan(NOW)).unreadable).toEqual([]);
    await mkdir(machine.roots.opencodeData, { recursive: true });
    const db = new DatabaseSync(join(machine.roots.opencodeData, "opencode.db"));
    db.exec("CREATE TABLE session_v9 (id TEXT)");
    db.close();
    const scan = await svc.scan(NOW);
    expect(scan.unreadable).toEqual(["opencode"]);
    expect(scan.chats).toHaveLength(5);
  });
});
