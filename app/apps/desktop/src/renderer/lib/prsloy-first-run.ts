/**
 * PRSLOY first run: which screen to show, and gateway error codes → i18n keys.
 * Pure helpers so the gate component stays thin (and testable without Electron).
 */
import type { PrsloyGatewayErrorCode, PrsloyState } from "@zeno/contracts";
import type { Locale, MessageKey } from "./i18n.ts";

export type FirstRunStep = "loading" | "key" | "import" | "search" | "folder" | "done";

/** Optional steps between the key and the folder, passed by «Готово» or «Пропустить». */
export type FirstRunSeen = { import?: boolean; search?: boolean };

/** Props of every optional step component: it calls onDone on «Готово» or «Пропустить». */
export type FirstRunStepProps = { locale: Locale; onDone: () => void };

export const FIRST_RUN_SEEN_KEYS = {
  import: "prsloy.firstRun.importSeen",
  search: "prsloy.firstRun.searchSeen",
} as const;

/**
 * Key → import chats from other agents → search → folder → the app. The optional steps belong
 * to a real first run only (no project folder yet): people who already work in the app are not
 * stopped by them after an update; they find them in settings.
 */
export function firstRunStep(
  state: PrsloyState | undefined,
  seen: FirstRunSeen = {},
): FirstRunStep {
  if (!state) return "loading";
  if (state.firstRunBypass) return "done";
  if (!state.hasKey) return "key";
  if (!state.needsWorkspace) return "done";
  if (!seen.import) return "import";
  if (!seen.search) return "search";
  return "folder";
}

export function readFirstRunSeen(): FirstRunSeen {
  const seen: FirstRunSeen = {};
  for (const step of ["import", "search"] as const) {
    try {
      if (localStorage.getItem(FIRST_RUN_SEEN_KEYS[step]) === "1") seen[step] = true;
    } catch {
      // storage blocked: the step shows again, nothing breaks
    }
  }
  return seen;
}

export function markFirstRunSeen(step: keyof FirstRunSeen): void {
  try {
    localStorage.setItem(FIRST_RUN_SEEN_KEYS[step], "1");
  } catch {
    // storage blocked
  }
}

const ERROR_KEYS: Record<PrsloyGatewayErrorCode, MessageKey> = {
  invalid_key: "prsloy.error.invalid_key",
  no_balance: "prsloy.error.no_balance",
  network: "prsloy.error.network",
  timeout: "prsloy.error.timeout",
  server: "prsloy.error.server",
  bad_url: "prsloy.error.bad_url",
};

export function gatewayErrorKey(code: PrsloyGatewayErrorCode | undefined): MessageKey {
  return (code && ERROR_KEYS[code]) || "prsloy.error.server";
}

/**
 * «Готовлю приложение… N%» while runtimes (Node/Python/Git) unpack on first launch;
 * undefined when nothing is installing.
 */
export function appSetupPercent(state: PrsloyState | undefined): string | undefined {
  const setup = state?.appSetup ?? state?.gitSetup;
  if (setup?.status !== "installing") return undefined;
  return String(setup.percent ?? 0);
}

/** Strip whitespace and invisible characters people paste along with a key. */
export function cleanPastedKey(raw: string): string {
  return raw.replace(/[\s​-‍﻿]+/gu, "");
}
