/**
 * Asks the user before the agent changes anything outside the project (rules in
 * write-boundary-rules.ts). A Pi extension: `tool_call` blocks the call until the user
 * answers a Russian dialog in the app (ctx.ui.select → host → renderer ExtensionUiHost).
 *
 * - «Да» allows this one call.
 * - «Разрешать в этом разговоре» allows every such call in this session (not in others,
 *   not after a restart).
 * - «Нет», closing the dialog, or no UI at all blocks the call; a refused call stays
 *   refused for the session, the agent is not allowed to ask again by retrying.
 */
import { tmpdir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  classifyBash,
  classifyFileWrite,
  type BoundaryEnv,
  type BoundaryVerdict,
} from "./write-boundary-rules.ts";

export const ANSWER_YES = "Да";
export const ANSWER_NO = "Нет";
export const ANSWER_SESSION = "Разрешать в этом разговоре";

const REFUSED_NOTE =
  "Пользователь не разрешил это действие. Не повторяй его и не обходи другим способом " +
  "(другой командой, через скрипт). Если без него не обойтись, объясни пользователю зачем.";
const NO_UI_NOTE =
  "Это действие меняет файлы вне проекта, а спросить пользователя сейчас нельзя. " +
  "Работай внутри папки проекта.";

type SessionMemory = { allowAll: boolean; refused: Set<string> };

export function verdictFor(
  toolName: string,
  input: Record<string, unknown>,
  env: BoundaryEnv,
): BoundaryVerdict {
  if ((toolName === "write" || toolName === "edit") && typeof input.path === "string") {
    return classifyFileWrite(input.path, env);
  }
  if (toolName === "bash" && typeof input.command === "string") {
    return classifyBash(input.command, env);
  }
  return { ask: false };
}

export function createWriteBoundary(
  options: { extraAllowedRoots?: string[]; platform?: NodeJS.Platform } = {},
) {
  return (pi: ExtensionAPI): void => {
    const sessions = new Map<string, SessionMemory>();
    const memoryFor = (id: string): SessionMemory => {
      let memory = sessions.get(id);
      if (!memory) {
        memory = { allowAll: false, refused: new Set() };
        sessions.set(id, memory);
      }
      return memory;
    };

    pi.on("tool_call", async (event, ctx) => {
      const env: BoundaryEnv = {
        cwd: ctx.cwd,
        allowedRoots: [ctx.cwd, tmpdir(), ...(options.extraAllowedRoots ?? [])],
        ...(options.platform ? { platform: options.platform } : {}),
      };
      const verdict = verdictFor(event.toolName, event.input as Record<string, unknown>, env);
      if (!verdict.ask) return undefined;
      const memory = memoryFor(ctx.sessionManager.getSessionId());
      if (memory.allowAll) return undefined;
      if (memory.refused.has(verdict.key)) return { block: true, reason: REFUSED_NOTE };
      if (!ctx.hasUI) return { block: true, reason: NO_UI_NOTE };
      const answer = await ctx.ui.select(
        verdict.question,
        [ANSWER_YES, ANSWER_NO, ANSWER_SESSION],
        ctx.signal ? { signal: ctx.signal } : {},
      );
      if (answer === ANSWER_YES) return undefined;
      if (answer === ANSWER_SESSION) {
        memory.allowAll = true;
        return undefined;
      }
      memory.refused.add(verdict.key);
      return { block: true, reason: REFUSED_NOTE };
    });
  };
}
