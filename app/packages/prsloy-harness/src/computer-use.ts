import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Munim actions must use element IDs; coordinate and focus-based actions are not exposed. */
export const COMPUTER_USE_TOOL_NAMES = [
  "list_apps",
  "get_app_state",
  "click",
  "type_text",
  "set_value",
  "screenshot",
  "wait",
] as const;
export type ComputerUseToolName = (typeof COMPUTER_USE_TOOL_NAMES)[number];
const PREFIX = "mcp__munimComputerUse__";
const ALLOWED = new Set<string>(COMPUTER_USE_TOOL_NAMES);
const ACTIONS = new Set(["click", "type_text", "set_value"]);

export type ComputerUseState = {
  aborted: boolean;
  snapshotId: string | undefined;
  targetPid: number | undefined;
  action: string | undefined;
  elementIds: Set<string>;
  turnId: number;
};
export function createComputerUseState(): ComputerUseState {
  return {
    aborted: false,
    snapshotId: undefined,
    targetPid: undefined,
    action: undefined,
    elementIds: new Set(),
    turnId: 0,
  };
}
export function snapshotIdFor(targetPid: number, serial: string): string {
  return `${targetPid}:${serial}`;
}
export function validateComputerUseTarget(
  state: ComputerUseState,
  input: { targetPid?: number; snapshotId?: string; elementId?: string },
): string | undefined {
  if (state.aborted) return "Computer-use остановлен пользователем.";
  if (state.targetPid === undefined || state.snapshotId === undefined)
    return "Сначала перечитай состояние выбранного окна.";
  if (input.targetPid !== undefined && input.targetPid !== state.targetPid)
    return "Действие отклонено: выбран другой PID окна.";
  if (input.snapshotId !== undefined && input.snapshotId !== state.snapshotId)
    return "Действие отклонено: snapshot устарел.";
  if (!input.elementId || !state.elementIds.has(input.elementId))
    return "Действие отклонено: element_id отсутствует в последнем snapshot.";
  return undefined;
}

function textFromContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
        ? (part as { text: string }).text
        : "",
    )
    .join("\n");
}
function pidFromApp(input: Record<string, unknown>): number | undefined {
  const value = input.app ?? input.targetPid ?? input.pid;
  const pid =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/u.test(value)
        ? Number(value)
        : NaN;
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}
function status(ctx: ExtensionContext, value: string): void {
  ctx.ui.setStatus("computer-use", `Windows: ${value}`);
}

/** Pi hooks guard the actual Munim schema; the backend owns UIA element resolution. */
export function installComputerUseGuard(pi: ExtensionAPI): void {
  const state = createComputerUseState();
  let turn = 0;
  let sequence = 0;
  let observationEpoch = 0;
  let availablePids = new Set<number>();
  const pending = new Map<string, { turn: number; name: string; pid?: number; epoch?: number }>();
  pi.on("before_agent_start", (event) => {
    if (event.messageType !== "user") return;
    turn += 1;
    Object.assign(state, createComputerUseState(), { turnId: turn });
    availablePids = new Set();
    pending.clear();
  });
  pi.on("tool_call", (event, ctx) => {
    if (!event.toolName.startsWith(PREFIX)) return;
    const name = event.toolName.slice(PREFIX.length);
    if (!ALLOWED.has(name))
      return { block: true, reason: "Инструмент Munim не разрешён в этом режиме." };
    if (state.aborted) return { block: true, reason: "Computer-use остановлен пользователем." };
    const input = event.input as Record<string, unknown>;
    const pid = pidFromApp(input);
    if (name === "get_app_state") {
      if (!pid || !availablePids.has(pid))
        return { block: true, reason: "Выбери PID из последнего списка окон." };
      if (state.targetPid !== undefined && pid !== state.targetPid)
        return { block: true, reason: "Другое окно: начни новый запрос пользователя." };
      state.targetPid = pid;
      observationEpoch += 1;
      state.snapshotId = undefined;
      state.elementIds.clear();
      pending.set(event.toolCallId, { turn, name, pid, epoch: observationEpoch });
      status(ctx, `читаю PID ${pid}`);
      return;
    }
    if (name === "screenshot" && (!pid || pid !== state.targetPid))
      return { block: true, reason: "Снимок разрешён только для выбранного PID." };
    if (name === "wait") {
      observationEpoch += 1;
      state.snapshotId = undefined;
      state.elementIds.clear();
    }
    if (ACTIONS.has(name)) {
      if (input.x !== undefined || input.y !== undefined)
        return { block: true, reason: "Координатные действия не разрешены." };
      const elementId =
        typeof input.element_id === "string"
          ? input.element_id
          : typeof input.elementId === "string"
            ? input.elementId
            : undefined;
      const snapshotId = typeof input.snapshotId === "string" ? input.snapshotId : undefined;
      const error = validateComputerUseTarget(state, {
        ...(pid === undefined ? {} : { targetPid: pid }),
        ...(elementId === undefined ? {} : { elementId }),
        ...(snapshotId === undefined ? {} : { snapshotId }),
      });
      if (error) return { block: true, reason: error };
      // Invalidate before dispatch: even a failed/aborted call may have acted.
      state.snapshotId = undefined;
      state.elementIds.clear();
      observationEpoch += 1;
    }
    pending.set(event.toolCallId, { turn, name });
    status(
      ctx,
      name === "list_apps"
        ? "читаю окна"
        : name === "wait"
          ? "ожидаю"
          : name === "screenshot"
            ? "снимаю изображение"
            : "выполняю действие",
    );
  });
  pi.on("tool_result", (event, ctx) => {
    if (!event.toolName.startsWith(PREFIX)) return;
    const call = pending.get(event.toolCallId);
    pending.delete(event.toolCallId);
    if (!call || call.turn !== turn || state.aborted) return;
    const text = textFromContent(event.content);
    if (call.name === "list_apps") {
      const rows = new Map<number, number>();
      if (!event.isError) {
        for (const match of text.matchAll(
          /^[^\r\n]*?[ \t]{2}\[[^\]\r\n]+\][ \t]+pid=(\d+)[ \t]+windows=(\d+)(?=[ \t]|$)([^\r\n]*)/gimu,
        )) {
          const pid = Number(match[1]);
          const windows = /(?:^|[ \t])windows=/iu.test(match[3] ?? "") ? 0 : Number(match[2]);
          rows.set(pid, rows.has(pid) ? 0 : windows);
        }
      }
      // Munim identifies a process, not an HWND: refuse known multi-window
      // targets. This observation is not an OS-enforced window binding.
      availablePids = new Set(
        [...rows]
          .filter(([pid, windows]) => Number.isSafeInteger(pid) && pid > 0 && windows === 1)
          .map(([pid]) => pid),
      );
    } else if (
      call.name === "get_app_state" &&
      !event.isError &&
      call.epoch === observationEpoch &&
      call.pid === state.targetPid &&
      new RegExp(`^\\s*${call.pid}\\s*\\(pid\\s+${call.pid}\\)`, "iu").test(text)
    ) {
      sequence += 1;
      state.snapshotId = snapshotIdFor(call.pid!, String(sequence));
      state.elementIds = new Set(Array.from(text.matchAll(/\[(e\d+)\]/giu), (match) => match[1]!));
    }
    status(ctx, event.isError ? "ошибка" : "готово");
    // Preserve the original MCP content, including images. Munim reuses IDs, so
    // no synthetic fingerprint is advertised as backend-enforced freshness.
  });
  pi.on("agent_settled", (event) => {
    if (event.aborted) {
      state.aborted = true;
      state.snapshotId = undefined;
      state.elementIds.clear();
      pending.clear();
    }
  });
}
