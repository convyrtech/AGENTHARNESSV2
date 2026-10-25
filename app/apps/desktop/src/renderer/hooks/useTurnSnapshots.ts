/**
 * Snapshots main took before each agent turn in this workspace (newest first). Re-read
 * whenever the timeline settles with new content; empty outside Electron (browser demo)
 * or with an older main that has no PRSLOY IPC.
 */
import { useEffect, useState } from "react";
import type { PrsloyTurnSnapshot } from "@zeno/contracts";

export function useTurnSnapshots(running: boolean, revision: string): PrsloyTurnSnapshot[] {
  const [snapshots, setSnapshots] = useState<PrsloyTurnSnapshot[]>([]);

  useEffect(() => {
    const api = typeof window !== "undefined" && "zeno" in window ? window.zeno.prsloy : undefined;
    if (running || !api) return;
    let cancelled = false;
    api
      .listTurns()
      .then((next) => {
        if (!cancelled) setSnapshots(next);
      })
      .catch(() => {
        if (!cancelled) setSnapshots([]);
      });
    return () => {
      cancelled = true;
    };
  }, [running, revision]);

  return snapshots;
}
