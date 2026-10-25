/**
 * First-run step «import» between the key and the folder: chats from other agents (Claude Code, Codex, Pi). Owned by ui, #22 I1.
 * Placeholder until then: passes at once.
 */
import { useEffect } from "react";
import type { FirstRunStepProps } from "@/lib/prsloy-first-run";

export function FirstRunImport({ onDone }: FirstRunStepProps) {
  useEffect(() => {
    onDone();
  }, [onDone]);
  return null;
}
