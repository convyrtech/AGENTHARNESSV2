import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const CUA_COMPUTER_USE_TOOL_NAMES = [
  "list_apps",
  "list_windows",
  "get_window_state",
  "click",
  "type_text",
] as const;
const PREFIX = "mcp__cuaComputerUse__";
const ALLOWED = new Set<string>(CUA_COMPUTER_USE_TOOL_NAMES);
const ACTIONS = new Set(["click", "type_text"]);
const RECOVERY_BLOCKED_WARNING =
  "Recovery gate остаётся заблокированным: результат действия не подтверждён безопасно. Не повторяй его вслепую; проверь состояние и дождись решения владельца.";
type WindowTarget = { pid: number; windowId: number };
export type CuaRecoveryActionKind = "click" | "type_text";
export interface CuaRecoveryGate {
  /** Synchronously commit a durable intent. Throw to fail closed before Cua dispatch. */
  beginAction(input: {
    operationId: string;
    pid: number;
    windowId: number;
    kind: CuaRecoveryActionKind;
  }): string;
  /** Only the specific Cua UIA ValuePattern read-back may be confirmed_applied. */
  recordOutcome(actionId: string, outcome: "confirmed_applied" | "ambiguous"): void;
  /** Preserve unknown after Stop. */
  recordAbort(actionId: string): void;
}
type CuaState = {
  aborted: boolean;
  target?: WindowTarget;
  epoch: number;
  tokens: Set<string>;
};
function freshState(): CuaState {
  return { aborted: false, epoch: 0, tokens: new Set() };
}
function positiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function contentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content.map((item) => (typeof item?.text === "string" ? item.text : "")).join("\n");
}
function structuredLayers(value: unknown): Record<string, unknown>[] {
  const layers: Record<string, unknown>[] = [];
  let current: unknown = value;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
    const record = current as Record<string, unknown>;
    layers.push(record);
    current = record.structuredContent;
  }
  return layers;
}
/** Confirmation refers to the driver's accessibility read-back, not a business outcome. */
export function cuaEffect(value: unknown): "confirmed" | "unknown" {
  const reports = structuredLayers(value).filter(
    (layer) => "effect" in layer || "verified" in layer,
  );
  return reports.some((layer) => layer.effect === "confirmed") &&
    reports.every(
      (layer) =>
        (layer.effect === undefined || layer.effect === "confirmed") && layer.verified !== false,
    )
    ? "confirmed"
    : "unknown";
}
/** Cua 0.38 Windows type_text result contract, deliberately narrower than a click. */
export function cuaTypeTextReadback(value: unknown): boolean {
  const layers = structuredLayers(value);
  if (layers.some((layer) => layer.isError === true)) return false;
  const effects = layers.filter((layer) => "effect" in layer);
  if (
    effects.length === 0 ||
    effects.some((layer) => layer.effect !== "confirmed") ||
    layers.some((layer) => layer.verified === false)
  )
    return false;
  const evidenceRows = layers.flatMap((layer) =>
    Array.isArray(layer.evidence) ? (layer.evidence as unknown[]) : [],
  );
  return evidenceRows.some(
    (row) =>
      row !== null &&
      typeof row === "object" &&
      (row as Record<string, unknown>).kind === "value_readback" &&
      (row as Record<string, unknown>).detail === "confirmed",
  );
}
export function classifyCuaActionOutcome(input: {
  name: string | undefined;
  isError: boolean | undefined;
  hasActiveWrapper: boolean;
  signalAborted: boolean;
  result: unknown;
}): "confirmed_applied" | "ambiguous" {
  return input.name === "type_text" &&
    input.isError === false &&
    input.hasActiveWrapper &&
    !input.signalAborted &&
    cuaTypeTextReadback(input.result)
    ? "confirmed_applied"
    : "ambiguous";
}
function windowTargets(value: unknown, text: string): WindowTarget[] {
  const candidates: unknown[] = [];
  for (const record of structuredLayers(value)) {
    for (const key of ["windows", "items", "results"]) {
      if (Array.isArray(record[key])) candidates.push(...(record[key] as unknown[]));
    }
  }
  for (const line of text.split(/\r?\n/u)) {
    try {
      const parsed: unknown = JSON.parse(line);
      if (Array.isArray(parsed)) candidates.push(...parsed);
      else if (parsed && typeof parsed === "object") candidates.push(parsed);
    } catch {
      // Human-readable list output is deliberately not guessed: use structured windows.
    }
  }
  const targets: WindowTarget[] = [];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const row = candidate as Record<string, unknown>;
    const pid = row.pid;
    const windowId = row.window_id ?? row.windowId;
    if (positiveSafeInteger(pid) && positiveSafeInteger(windowId)) targets.push({ pid, windowId });
  }
  return targets;
}
function snapshotTokens(value: unknown, text: string): Set<string> {
  const tokens = new Set<string>();
  for (const record of structuredLayers(value)) {
    // Cua 0.38 defaults to compact Markdown: actionable rows carry only an
    // index, while snapshot_id supplies the generation of the native token.
    if (
      typeof record.snapshot_id === "string" &&
      /^s[0-9a-f]{8}$/u.test(record.snapshot_id) &&
      typeof record.tree_markdown === "string"
    ) {
      for (const match of record.tree_markdown.matchAll(/^\s*[-*]?\s*\[(\d+)\]/gmu))
        tokens.add(`${record.snapshot_id}:${match[1]}`);
    }
    const elements = record.elements;
    if (Array.isArray(elements)) {
      for (const element of elements) {
        if (element && typeof element === "object") {
          const token = (element as Record<string, unknown>).element_token;
          if (typeof token === "string" && /^s[0-9a-f]{8}:\d+$/u.test(token)) tokens.add(token);
        }
      }
    }
  }
  for (const match of text.matchAll(/\bs[0-9a-f]{8}:\d+\b/giu)) tokens.add(match[0]);
  return tokens;
}
function inputTarget(input: Record<string, unknown>): WindowTarget | undefined {
  const pid = input.pid;
  const windowId = input.window_id ?? input.windowId;
  return positiveSafeInteger(pid) && positiveSafeInteger(windowId) ? { pid, windowId } : undefined;
}
function sameTarget(left: WindowTarget | undefined, right: WindowTarget | undefined): boolean {
  return Boolean(left && right && left.pid === right.pid && left.windowId === right.windowId);
}
function status(ctx: ExtensionContext, value: string): void {
  ctx.ui.setStatus("computer-use", `Cua: ${value}`);
}

/** Strict guard for Cua's native snapshot-bound handles. MCP image blocks are passed through
 * unchanged; action tokens are consumed before dispatch because Stop cannot undo native input. */
export function installCuaComputerUseGuard(pi: ExtensionAPI, recoveryGate?: CuaRecoveryGate): void {
  let state = freshState();
  let turn = 0;
  let epoch = 0;
  let windows: WindowTarget[] = [];
  const pending = new Map<
    string,
    {
      turn: number;
      name: string;
      epoch?: number;
      target?: WindowTarget;
      wrapperId?: string;
      aborted?: boolean;
    }
  >();
  // Action leases survive user-turn resets so late results cannot be lost.
  const actionCalls = new Map<
    string,
    {
      actionId: string;
      wrapperId: string;
      aborted: boolean;
      abortPersisted: boolean;
      outcomePersisted: boolean;
    }
  >();
  // Pi call IDs are unique within their parent tool call; retain tombstones so late events
  // cannot be mistaken for a currently pending action after wrapper cleanup.
  const ignoredActionResults = new Set<string>();
  // A wrapper may clear its uncertainty warning only after tool_result is durably recorded.
  const wrapperActionOutcomes = new Map<string, "pending" | "confirmed_applied" | "ambiguous">();
  const activeWrappers = new Map<
    string,
    { signal?: AbortSignal; aborted: boolean; onAbort?: () => void }
  >();
  function abortActiveCalls(): void {
    state.aborted = true;
    state.tokens.clear();
    delete state.target;
    epoch += 1;
    windows = [];
    for (const wrapper of activeWrappers.values()) wrapper.aborted = true;
    for (const [callId, call] of pending) {
      call.aborted = true;
      if (ACTIONS.has(call.name)) ignoredActionResults.add(callId);
    }
    for (const lease of actionCalls.values()) {
      if (lease.aborted) continue;
      lease.aborted = true;
      wrapperActionOutcomes.set(lease.wrapperId, "ambiguous");
      try {
        recoveryGate?.recordAbort(lease.actionId);
        lease.abortPersisted = true;
      } catch {
        // Keep the durable action unresolved if abort persistence fails.
      }
    }
  }
  pi.on("before_agent_start", (event) => {
    if (event.messageType !== "user") return;
    turn += 1;
    state = freshState();
    epoch = 0;
    windows = [];
    for (const [callId, call] of pending) if (!ACTIONS.has(call.name)) pending.delete(callId);
  });
  pi.on("tool_call", (event, ctx) => {
    if (!event.toolName.startsWith(PREFIX)) return;
    const name = event.toolName.slice(PREFIX.length);
    if (!ALLOWED.has(name)) return { block: true, reason: "Этот инструмент Cua не разрешён." };
    const wrapper = event.parentToolCallId ? activeWrappers.get(event.parentToolCallId) : undefined;
    if (!event.parentToolCallId || !wrapper)
      return { block: true, reason: "Сырые инструменты Cua доступны только через PRSLOY wrapper." };
    if (state.aborted || wrapper.aborted || wrapper.signal?.aborted)
      return { block: true, reason: "Computer-use остановлен; действие не запускаю." };
    const input = event.input as Record<string, unknown>;
    if (name === "list_windows") {
      if (Object.keys(input).some((key) => key !== "pid"))
        return { block: true, reason: "Список окон принимает только необязательный PID." };
      const filterPid = input.pid;
      if (filterPid !== undefined && !positiveSafeInteger(filterPid))
        return { block: true, reason: "PID окна должен быть положительным целым числом." };
      // Starting a valid list invalidates every earlier list and snapshot, including reads
      // which are still in flight. Only this generation may repopulate window membership.
      const listEpoch = ++epoch;
      windows = [];
      state.tokens.clear();
      pending.set(event.toolCallId, {
        turn,
        name,
        epoch: listEpoch,
        wrapperId: event.parentToolCallId,
      });
      status(ctx, "читаю список окон");
      return;
    }
    if (name === "get_window_state") {
      if (Object.keys(input).some((key) => !["pid", "window_id"].includes(key)))
        return {
          block: true,
          reason: "Чтение окна принимает только PID и window_id; запись файлов отключена.",
        };
      const target = inputTarget(input);
      if (!target || !windows.some((row) => sameTarget(row, target)))
        return { block: true, reason: "Укажи PID и window_id из последнего list_windows." };
      if (state.target && !sameTarget(state.target, target))
        return { block: true, reason: "Другое окно: начни новый запрос пользователя." };
      state.target = target;
      state.tokens.clear();
      const readEpoch = ++epoch;
      pending.set(event.toolCallId, {
        turn,
        name,
        epoch: readEpoch,
        target,
        wrapperId: event.parentToolCallId,
      });
      status(ctx, `снимаю окно PID ${target.pid}`);
      return;
    }
    if (ACTIONS.has(name)) {
      if (!recoveryGate)
        return {
          block: true,
          reason: "Recovery gate недоступен; Cua action запрещён до надёжной записи намерения.",
        };
      const allowedKeys =
        name === "click"
          ? new Set(["pid", "window_id", "element_token", "scope", "delivery_mode"])
          : new Set(["pid", "window_id", "element_token", "text", "scope", "delivery_mode"]);
      if (Object.keys(input).some((key) => !allowedKeys.has(key)))
        return {
          block: true,
          reason: "Действие содержит неразрешённые поля; координаты и target override запрещены.",
        };
      const target = inputTarget(input);
      const nestedTarget = input.target;
      const hasNestedWindow = nestedTarget !== undefined;
      const nestedMatches =
        !hasNestedWindow ||
        (nestedTarget !== null &&
          typeof nestedTarget === "object" &&
          (nestedTarget as Record<string, unknown>).kind === "window" &&
          (nestedTarget as Record<string, unknown>).pid === target?.pid &&
          (nestedTarget as Record<string, unknown>).window_id === target?.windowId);
      if (!target || !sameTarget(target, state.target) || !nestedMatches)
        return { block: true, reason: "Действие требует текущие pid/window_id одного окна." };
      if (input.x !== undefined || input.y !== undefined || input.scope === "desktop")
        return { block: true, reason: "Координаты и действия на рабочем столе запрещены." };
      if (input.scope !== undefined && input.scope !== "window")
        return { block: true, reason: "Разрешены только действия в окне." };
      if (input.delivery_mode !== undefined && input.delivery_mode !== "background")
        return { block: true, reason: "Foreground/focus-переключение запрещено." };
      input.scope = "window";
      input.delivery_mode = "background";
      const token = input.element_token;
      if (typeof token !== "string" || !state.tokens.has(token))
        return { block: true, reason: "Нужен element_token из последнего snapshot этого окна." };
      state.tokens.delete(token);
      const actionEpoch = ++epoch;
      state.tokens.clear();
      try {
        const actionId = recoveryGate.beginAction({
          operationId: event.toolCallId,
          pid: target.pid,
          windowId: target.windowId,
          kind: name as CuaRecoveryActionKind,
        });
        if (typeof actionId !== "string" || actionId.length === 0)
          throw new Error("Recovery gate returned an invalid action ID");
        actionCalls.set(event.toolCallId, {
          actionId,
          wrapperId: event.parentToolCallId,
          aborted: false,
          abortPersisted: false,
          outcomePersisted: false,
        });
        wrapperActionOutcomes.set(event.parentToolCallId, "pending");
      } catch (error) {
        state.tokens.clear();
        return {
          block: true,
          reason: `Не удалось надёжно записать действие; Cua не вызван. ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      pending.set(event.toolCallId, { turn, name, epoch: actionEpoch, target });
      status(ctx, `действую в окне PID ${target.pid}`);
      return;
    }
    // list_apps is informational. No other Cua tool may pass this boundary.
    pending.set(event.toolCallId, { turn, name, wrapperId: event.parentToolCallId });
    status(ctx, name === "list_apps" ? "читаю приложения" : "готово");
  });
  pi.on("tool_result", (event, ctx) => {
    if (!event.toolName.startsWith(PREFIX)) return;
    const call = pending.get(event.toolCallId);
    const lease = actionCalls.get(event.toolCallId);
    const wrapper = call ? activeWrappers.get(call.wrapperId ?? "") : undefined;
    if (wrapper?.signal?.aborted) abortActiveCalls();
    const aborted =
      ignoredActionResults.has(event.toolCallId) ||
      call?.aborted === true ||
      wrapper?.aborted === true ||
      wrapper?.signal?.aborted === true ||
      state.aborted;
    pending.delete(event.toolCallId);
    if (aborted) {
      if (lease && !lease.abortPersisted) {
        try {
          recoveryGate?.recordAbort(lease.actionId);
          lease.abortPersisted = true;
        } catch {
          // The committed write-ahead row remains unresolved.
        }
      }
      ignoredActionResults.add(event.toolCallId);
      return {
        content: [
          { type: "text", text: "Результат Cua отброшен после Stop; данные окна не обновлены." },
        ],
        isError: true,
      };
    }
    if (lease) {
      if (lease.aborted) {
        if (!lease.abortPersisted) {
          try {
            recoveryGate?.recordAbort(lease.actionId);
            lease.abortPersisted = true;
          } catch {
            // Wrapper-finally retries once; durable intent remains pending if it still fails.
          }
        }
      } else {
        const classified = classifyCuaActionOutcome({
          name: call?.name,
          isError: event.isError,
          hasActiveWrapper: activeWrappers.has(lease.wrapperId),
          signalAborted:
            activeWrappers.get(lease.wrapperId)?.aborted === true ||
            activeWrappers.get(lease.wrapperId)?.signal?.aborted === true,
          result: event.structuredContent,
        });
        wrapperActionOutcomes.set(lease.wrapperId, "ambiguous");
        try {
          // Driver-level read-back does not establish the application's business outcome.
          recoveryGate?.recordOutcome(lease.actionId, classified);
          lease.outcomePersisted = true;
          actionCalls.delete(event.toolCallId);
          if (classified === "confirmed_applied")
            wrapperActionOutcomes.set(lease.wrapperId, "confirmed_applied");
        } catch {
          // The committed intent remains blocking on persistence failure.
        }
      }
    }
    if (!call || call.turn !== turn || lease?.aborted) {
      return {
        content: [{ type: "text", text: "Неподтверждённый результат Cua отброшен." }],
        isError: true,
      };
    }
    const text = contentText(event.content);
    if (call.name === "list_windows") {
      if (call.epoch !== epoch)
        return {
          content: [
            { type: "text", text: "Устаревший список окон отброшен; запусти list_windows заново." },
          ],
          isError: true,
        };
      windows = event.isError ? [] : windowTargets(event.structuredContent, text);
      if (state.target && !windows.some((row) => sameTarget(row, state.target))) {
        delete state.target;
        state.tokens.clear();
      }
    } else if (call.name === "get_window_state") {
      if (call.epoch !== epoch || !sameTarget(call.target, state.target))
        return {
          content: [
            { type: "text", text: "Устаревший снимок окна отброшен; сними состояние заново." },
          ],
          isError: true,
        };
      if (!event.isError) state.tokens = snapshotTokens(event.structuredContent, text);
    } else if (ACTIONS.has(call.name)) {
      // Always require a fresh observation after any attempted side effect, including an error.
      state.tokens.clear();
    }
    status(ctx, event.isError ? "ошибка; обнови состояние перед продолжением" : "готово");
  });
  pi.on("agent_settled", (event) => {
    if (event.aborted) abortActiveCalls();
  });

  const nested = async (
    id: string,
    ctx: import("@earendil-works/pi-coding-agent").ExtensionToolContext,
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) => {
    const wrapper = { ...(signal ? { signal } : {}), aborted: signal?.aborted ?? false } as {
      signal?: AbortSignal;
      aborted: boolean;
      onAbort?: () => void;
    };
    wrapper.onAbort = () => {
      wrapper.aborted = true;
      abortActiveCalls();
      for (const lease of actionCalls.values()) {
        if (lease.wrapperId !== id || lease.aborted) continue;
        lease.aborted = true;
        wrapperActionOutcomes.set(lease.wrapperId, "ambiguous");
        try {
          recoveryGate?.recordAbort(lease.actionId);
          lease.abortPersisted = true;
        } catch {
          // The committed intent remains unresolved if cancellation persistence fails.
        }
      }
    };
    if (signal?.aborted) wrapper.onAbort();
    else signal?.addEventListener("abort", wrapper.onAbort, { once: true });
    activeWrappers.set(id, wrapper);
    if (ACTIONS.has(name)) wrapperActionOutcomes.set(id, "ambiguous");
    try {
      const outcome = await ctx.executeTool(
        `${PREFIX}${name}`,
        args,
        signal ? { signal } : undefined,
      );
      if (wrapper.aborted || signal?.aborted)
        throw new Error(
          ACTIONS.has(name)
            ? `Результат действия Cua неизвестен после Stop. Оно могло выполниться; проверь состояние перед любым повтором. ${RECOVERY_BLOCKED_WARNING}`
            : `Результат чтения Cua отброшен после Stop; данные окна не обновлены.`,
        );
      if (ACTIONS.has(name) && (wrapper.aborted || signal?.aborted))
        throw new Error(
          `Результат действия Cua неизвестен после Stop. Оно могло выполниться; проверь состояние перед любым повтором. ${RECOVERY_BLOCKED_WARNING}`,
        );
      if (outcome.isError) {
        const nestedText = contentText(outcome.result.content);
        if (ACTIONS.has(name))
          throw new Error(
            `Результат действия Cua неизвестен: оно могло выполниться. Не повторяй действие; сначала сними новое состояние окна. ${RECOVERY_BLOCKED_WARNING} ${nestedText}`,
          );
        throw new Error(nestedText || `Cua ${name} failed.`);
      }
      if (ACTIONS.has(name) && wrapperActionOutcomes.get(id) !== "confirmed_applied") {
        return {
          ...outcome.result,
          content: [
            ...outcome.result.content,
            {
              type: "text" as const,
              text: `${RECOVERY_BLOCKED_WARNING} Оно могло выполниться. Прочитай состояние окна и проверь результат.`,
            },
          ],
        };
      }
      return outcome.result;
    } finally {
      for (const [callId, lease] of actionCalls) {
        if (lease.wrapperId !== id) continue;
        wrapperActionOutcomes.set(id, "ambiguous");
        if (lease.aborted) {
          if (!lease.abortPersisted) {
            try {
              recoveryGate?.recordAbort(lease.actionId);
              lease.abortPersisted = true;
            } catch {
              // Durable intent remains pending if abort persistence fails.
            }
          }
        } else if (!lease.outcomePersisted) {
          try {
            recoveryGate?.recordOutcome(lease.actionId, "ambiguous");
            lease.outcomePersisted = true;
          } catch {
            // Durable intent remains pending if ambiguity persistence fails.
          }
        }
        actionCalls.delete(callId);
        pending.delete(callId);
        ignoredActionResults.add(callId);
      }
      signal?.removeEventListener("abort", wrapper.onAbort);
      activeWrappers.delete(id);
      wrapperActionOutcomes.delete(id);
    }
  };
  const noArgs = Type.Object({}, { additionalProperties: false });
  const listWindowsParams = Type.Object(
    {
      pid: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: Number.MAX_SAFE_INTEGER,
          description: "Optional process ID to limit window discovery",
        }),
      ),
    },
    { additionalProperties: false },
  );
  pi.registerTool({
    name: "cua_list_apps",
    label: "Cua: приложения",
    description: "List running and installed applications for computer-use discovery.",
    parameters: noArgs,
    async execute(id, _params, signal, _onUpdate, ctx) {
      return nested(id, ctx, "list_apps", {}, signal);
    },
  });
  pi.registerTool({
    name: "cua_list_windows",
    label: "Cua: окна",
    description:
      "List windows and their exact process/window IDs before reading one; optionally filter by PID.",
    parameters: listWindowsParams,
    async execute(id, params, signal, _onUpdate, ctx) {
      return nested(id, ctx, "list_windows", params, signal);
    },
  });
  pi.registerTool({
    name: "cua_get_window_state",
    label: "Cua: снимок окна",
    description:
      "Read one exact window. Returns the current UI tree, snapshot-bound element tokens, and image.",
    parameters: Type.Object(
      {
        pid: Type.Integer({ minimum: 1, description: "PID from cua_list_windows" }),
        window_id: Type.Integer({ minimum: 1, description: "Exact HWND from cua_list_windows" }),
      },
      { additionalProperties: false },
    ),
    async execute(id, params, signal, _onUpdate, ctx) {
      return nested(id, ctx, "get_window_state", params, signal);
    },
  });
  pi.registerTool({
    name: "cua_click",
    label: "Cua: нажать элемент",
    description:
      "Click one accessibility element from the latest snapshot of this exact window. No coordinates or foreground focus switch.",
    parameters: Type.Object(
      {
        pid: Type.Integer({ minimum: 1 }),
        window_id: Type.Integer({ minimum: 1 }),
        element_token: Type.String({
          pattern: "^s[0-9a-f]{8}:[0-9]+$",
          description: "Exact token returned by the latest cua_get_window_state",
        }),
      },
      { additionalProperties: false },
    ),
    async execute(id, params, signal, _onUpdate, ctx) {
      return nested(id, ctx, "click", params, signal);
    },
  });
  pi.registerTool({
    name: "cua_type_text",
    label: "Cua: ввести текст",
    description:
      "Type text into one accessibility element from the latest snapshot of this exact window. No coordinates or foreground focus switch.",
    parameters: Type.Object(
      {
        pid: Type.Integer({ minimum: 1 }),
        window_id: Type.Integer({ minimum: 1 }),
        element_token: Type.String({
          pattern: "^s[0-9a-f]{8}:[0-9]+$",
          description: "Exact token returned by the latest cua_get_window_state",
        }),
        text: Type.String(),
      },
      { additionalProperties: false },
    ),
    async execute(id, params, signal, _onUpdate, ctx) {
      return nested(id, ctx, "type_text", params, signal);
    },
  });
}
