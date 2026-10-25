/**
 * PRSLOY first run: which screen to show, and gateway error codes → i18n keys.
 * Pure helpers so the gate component stays thin (and testable without Electron).
 */
import type { PrsloyGatewayErrorCode, PrsloyState } from "@zeno/contracts";
import type { MessageKey } from "./i18n.ts";

export type FirstRunStep = "loading" | "key" | "folder" | "done";

export function firstRunStep(state: PrsloyState | undefined): FirstRunStep {
  if (!state) return "loading";
  if (state.firstRunBypass) return "done";
  if (!state.hasKey) return "key";
  if (state.needsWorkspace) return "folder";
  return "done";
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

/** Strip whitespace and invisible characters people paste along with a key. */
export function cleanPastedKey(raw: string): string {
  return raw.replace(/[\s​-‍﻿]+/gu, "");
}
