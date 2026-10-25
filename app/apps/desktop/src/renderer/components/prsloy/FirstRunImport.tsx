/**
 * First-run step «import» between the key and the folder (#22 I1): chats from other agents
 * (Claude Code, Codex, Pi). Passes by itself when there is nothing to bring over.
 */
import type { FirstRunStepProps } from "@/lib/prsloy-first-run";
import { ImportChats } from "./ImportChats";

export function FirstRunImport({ locale, onDone }: FirstRunStepProps) {
  return <ImportChats locale={locale} mode="first-run" onDone={onDone} />;
}
