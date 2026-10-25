/**
 * Live casual-mode prefs for any component. Re-reads on the in-app change event and on
 * `storage` (another window, e.g. the pet), and keeps one object per stored value so
 * `useSyncExternalStore` sees a stable snapshot.
 */
import { useSyncExternalStore } from "react";
import {
  CASUAL_PREFS_CHANGED_EVENT,
  loadCasualPrefs,
  type CasualPrefs,
} from "../lib/casual-prefs.ts";

let cached: { key: string; prefs: CasualPrefs } | undefined;

function snapshot(): CasualPrefs {
  const prefs = loadCasualPrefs();
  const key = JSON.stringify(prefs);
  if (cached?.key !== key) cached = { key, prefs };
  return cached.prefs;
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(CASUAL_PREFS_CHANGED_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(CASUAL_PREFS_CHANGED_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

export function useCasualPrefs(): CasualPrefs {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
