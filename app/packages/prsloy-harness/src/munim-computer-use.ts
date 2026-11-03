import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { MunimSnapshotTokenStore } from "./munim-snapshot-tokens.ts";

export const MUNIM_COMPUTER_USE_TOOL_NAMES = [
  "list_apps",
  "get_app_state",
  "type_text",
  "click",
  "screenshot",
] as const;
const PREFIX = "mcp__munimComputerUse__";
const ALLOWED = new Set<string>(MUNIM_COMPUTER_USE_TOOL_NAMES);
const ACTIONS = new Set(["type_text", "click"]);
const READ_ONLY = new Set(["list_apps", "get_app_state", "screenshot"]);
const INVALIDATED =
  "Действие могло выполниться. Результат неизвестен: обнови состояние приложения и проверь эффект перед любым повтором.";

export type MunimActionKind = "type_text" | "click";
/** Durable gate is scoped to a process. Munim exposes no HWND, so this API deliberately has no window handle. */
export interface MunimRecoveryGate {
  /** Must synchronously commit the intent or throw before any Munim action dispatch. */
  beginAction(input: { operationId: string; pid: number; kind: MunimActionKind }): string;
  /** Every dispatched action remains unknown, regardless of tool success/error. */
  recordOutcome(actionId: string, outcome: "unknown"): void;
  /** Stop/abort leaves the durable action in unknown state. */
  recordAbort(actionId: string): void;
}

type Pending = {
  name: string;
  pid?: number;
  generation?: number;
  wrapperId: string;
  aborted?: boolean;
};
type Lease = { actionId: string; wrapperId: string; aborted: boolean; persisted: boolean };
type PreparedAction = Lease & { name: MunimActionKind; pid: number; args: Record<string, unknown> };
type ActiveWrapper = { signal?: AbortSignal; aborted: boolean; onAbort?: () => void };
type WrapperResult = Awaited<ReturnType<ExtensionToolContext["executeTool"]>>["result"];

function textContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
        ? (part as { text: string }).text
        : "",
    )
    .join("\n");
}
function readPid(input: Record<string, unknown>): number | undefined {
  const value = input.pid ?? input.app;
  const pid =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/u.test(value)
        ? Number(value)
        : NaN;
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}
function parseSingleWindowPids(text: string): Set<number> {
  const rows = new Map<number, number>();
  for (const match of text.matchAll(
    /^[^\r\n]*?\s\[[^\]\r\n]+\]\s+pid=(\d+)\s+windows=(\d+)(?=[ \t]|$)([^\r\n]*)/gimu,
  )) {
    const pid = Number(match[1]);
    const count = /(?:^|[ \t])windows=/iu.test(match[3] ?? "") ? 0 : Number(match[2]);
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    rows.set(pid, rows.has(pid) ? 0 : count);
  }
  return new Set([...rows].filter(([, count]) => count === 1).map(([pid]) => pid));
}
/** Validate Munim 0.9's own window summary before issuing element tokens. */
function isSingleWindowSnapshot(text: string, pid: number): boolean {
  const heading = new RegExp(
    `^\\s*${pid}\\s+\\(pid\\s+${pid}\\),\\s*(\\d+)\\s+window\\(s\\)(?:[ \\t]|$)`,
    "imu",
  );
  const firstLine = text.split(/\r?\n/u, 1)[0] ?? "";
  const match = heading.exec(firstLine);
  if (!match || Number(match[1]) !== 1) return false;
  // The driver emits one native-window identifier on its canonical window row.
  // This is a consistency check on the snapshot, not an OS-enforced action target.
  const windows = [...text.matchAll(/^──\s+window\s+(\d+):\s+.+?\s+window_id=(\d+)\s*$/gimu)];
  if (windows.length !== 1 || windows[0]![1] !== "0") return false;
  const windowId = Number(windows[0]![2]);
  return Number.isSafeInteger(windowId) && windowId > 0;
}
function idsIn(text: string): string[] {
  return [...new Set(Array.from(text.matchAll(/\[(e\d+)\]/giu), (match) => match[1]!))];
}
function replaceElementRefs(value: unknown, replacements: Map<string, string>): unknown {
  if (typeof value === "string")
    return value.replace(/\[(e\d+)\]/giu, (whole, id: string) => replacements.get(id) ?? whole);
  if (Array.isArray(value)) return value.map((item) => replaceElementRefs(item, replacements));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, replaceElementRefs(item, replacements)]),
    );
  return value;
}
function replaceContentRefs(content: unknown, replacements: Map<string, string>): unknown {
  if (!Array.isArray(content)) return content;
  return content.map((part) => {
    if (!part || typeof part !== "object" || typeof (part as { text?: unknown }).text !== "string")
      return part;
    return {
      ...(part as Record<string, unknown>),
      text: replaceElementRefs((part as { text: string }).text, replacements),
    };
  });
}
function status(ctx: ExtensionContext, text: string): void {
  ctx.ui.setStatus("computer-use", `Munim: ${text}`);
}
function sameArgs(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key])
  );
}
function persistUnknown(gate: MunimRecoveryGate | undefined, lease: Lease): void {
  if (lease.persisted) return;
  try {
    if (lease.aborted) gate?.recordAbort(lease.actionId);
    else gate?.recordOutcome(lease.actionId, "unknown");
    lease.persisted = true;
  } catch {
    /* durable row stays pending/unknown and blocks blind retry */
  }
}

/** Isolated wrapper guard. Do not register this extension in production until live packaged QA passes. */
export function installMunimComputerUseGuard(
  pi: ExtensionAPI,
  recoveryGate?: MunimRecoveryGate,
): void {
  const tokens = new MunimSnapshotTokenStore();
  let turn = 0;
  let generation = 0;
  let singleWindowPids = new Set<number>();
  let busy: string | undefined;
  const pending = new Map<string, Pending>();
  const actions = new Map<string, Lease>();
  const preparedActions = new Map<string, PreparedAction>();
  const preparedScreenshots = new Map<string, number>();
  const active = new Map<string, ActiveWrapper>();
  const sanitizedSnapshots = new Set<string>();
  const ignored = new Set<string>();

  function abortActiveCalls(): void {
    generation += 1;
    tokens.invalidate();
    singleWindowPids.clear();
    sanitizedSnapshots.clear();
    preparedScreenshots.clear();
    for (const wrapper of active.values()) wrapper.aborted = true;
    for (const call of pending.values()) if (READ_ONLY.has(call.name)) call.aborted = true;
    for (const [callId, lease] of actions) {
      lease.aborted = true;
      persistUnknown(recoveryGate, lease);
      ignored.add(callId);
    }
    for (const lease of preparedActions.values()) {
      lease.aborted = true;
      persistUnknown(recoveryGate, lease);
    }
    preparedActions.clear();
  }

  pi.on("before_agent_start", (event) => {
    if (event.messageType !== "user") return;
    const configured = pi.getActiveTools();
    pi.setActiveTools([
      ...new Set([
        ...configured.filter((name) => !name.startsWith(PREFIX)),
        ...MUNIM_COMPUTER_USE_TOOL_NAMES.map((name) => `munim_${name}`),
      ]),
    ]);
    turn += 1;
    generation += 1;
    singleWindowPids = new Set();
    tokens.invalidate();
    // In-flight operations keep their pending/lease records so their eventual result is unknown.
  });

  pi.on("tool_call", (event, ctx) => {
    if (!event.toolName.startsWith(PREFIX)) return;
    const name = event.toolName.slice(PREFIX.length);
    if (!ALLOWED.has(name)) return { block: true, reason: "Этот инструмент Munim не разрешён." };
    const parent = event.parentToolCallId;
    const wrapper = parent ? active.get(parent) : undefined;
    if (!parent || !wrapper)
      return { block: true, reason: "Сырые вызовы Munim разрешены только через Munim wrapper." };
    if (wrapper.aborted || wrapper.signal?.aborted)
      return { block: true, reason: "Действие остановлено; новый вызов не запускаю." };
    const input = event.input as Record<string, unknown>;
    if (name === "list_apps") {
      if (busy)
        return {
          block: true,
          reason: "Другой снимок или action ещё выполняется; конкурентный вызов закрыт.",
        };
      if (Object.keys(input).length)
        return { block: true, reason: "list_apps не принимает параметры." };
      singleWindowPids = new Set();
      tokens.invalidate();
      const op = ++generation;
      busy = event.toolCallId;
      pending.set(event.toolCallId, { name, generation: op, wrapperId: parent });
      status(ctx, "читаю приложения");
      return;
    }
    if (ACTIONS.has(name)) {
      const prepared = preparedActions.get(parent);
      if (prepared?.aborted || wrapper.aborted || wrapper.signal?.aborted)
        return { block: true, reason: "Action был остановлен до dispatch; raw вызов закрыт." };
      if (!prepared || name !== prepared.name || !sameArgs(input, prepared.args))
        return {
          block: true,
          reason: "Raw Munim action не совпал с заранее подготовленным вызовом wrapper.",
        };
      if (busy !== `wrapper:${parent}`)
        return { block: true, reason: "Action wrapper потерял эксклюзивную блокировку." };
      preparedActions.delete(parent);
      busy = event.toolCallId;
      actions.set(event.toolCallId, prepared);
      pending.set(event.toolCallId, { name, pid: prepared.pid, generation, wrapperId: parent });
      status(ctx, `выполняю ${name} в PID ${prepared.pid}`);
      return;
    }
    if (name === "screenshot") {
      const expectedPid = preparedScreenshots.get(parent);
      const pid = readPid(input);
      if (
        expectedPid === undefined ||
        !pid ||
        pid !== expectedPid ||
        typeof input.app !== "string" ||
        input.app !== String(expectedPid) ||
        Object.keys(input).length !== 1 ||
        Object.keys(input)[0] !== "app"
      )
        return {
          block: true,
          reason: "Screenshot принимает только app PID, заранее подготовленный wrapper-ом.",
        };
      if (busy !== `wrapper:${parent}`)
        return { block: true, reason: "Screenshot wrapper потерял эксклюзивную блокировку." };
      preparedScreenshots.delete(parent);
      busy = event.toolCallId;
      pending.set(event.toolCallId, { name, pid, generation, wrapperId: parent });
      status(ctx, `снимаю изображение PID ${pid}`);
      return;
    }
    if (busy)
      return {
        block: true,
        reason: "Другой снимок или action ещё выполняется; конкурентный вызов закрыт.",
      };
    const pid = readPid(input);
    if (!pid || !singleWindowPids.has(pid))
      return {
        block: true,
        reason: "Нужен PID с подтверждённым windows=1 из последнего list_apps.",
      };
    if (name === "get_app_state") {
      if (Object.keys(input).some((key) => !["pid", "app"].includes(key)))
        return { block: true, reason: "Чтение принимает только PID." };
      tokens.invalidate();
      const op = ++generation;
      busy = event.toolCallId;
      pending.set(event.toolCallId, { name, pid, generation: op, wrapperId: parent });
      status(ctx, `читаю PID ${pid}`);
      return;
    }
    return { block: true, reason: "Munim action без подготовленного top-level wrapper запрещён." };
  });

  pi.on("tool_result", (event, ctx) => {
    if (!event.toolName.startsWith(PREFIX)) return;
    if (ignored.has(event.toolCallId)) {
      pending.delete(event.toolCallId);
      actions.delete(event.toolCallId);
      if (busy === event.toolCallId) busy = undefined;
      return {
        content: [
          {
            type: "text",
            text: "Munim результат отброшен после Stop; проверь состояние перед продолжением.",
          },
        ],
        isError: true,
      };
    }
    const call = pending.get(event.toolCallId);
    const wrapper = call ? active.get(call.wrapperId) : undefined;
    if (wrapper?.signal?.aborted) {
      if (call) call.aborted = true;
      abortActiveCalls();
    }
    pending.delete(event.toolCallId);
    const lease = actions.get(event.toolCallId);
    if (lease) {
      persistUnknown(recoveryGate, lease);
      actions.delete(event.toolCallId);
    }
    if (!call)
      return { content: [{ type: "text", text: "Неподтверждённый результат Munim отброшен." }] };
    if (busy === event.toolCallId) busy = undefined;
    if (call.aborted || wrapper?.aborted || wrapper?.signal?.aborted) {
      tokens.invalidate();
      singleWindowPids.clear();
      sanitizedSnapshots.delete(call.wrapperId);
      status(ctx, "поздний результат после Stop отброшен");
      return {
        content: [
          { type: "text", text: "Munim результат отброшен после Stop; данные не обновлены." },
        ],
        isError: true,
      };
    }
    if (call.generation !== generation || event.isError) {
      if (call.name === "get_app_state") tokens.invalidate();
      status(ctx, "результат устарел или ошибка");
      if (call.name === "get_app_state")
        return {
          content: [
            { type: "text", text: "Munim snapshot отклонён; обнови состояние приложения." },
          ],
        };
      if (ACTIONS.has(call.name))
        return {
          content: [{ type: "text", text: "Munim action dispatched; результат неизвестен." }],
        };
      return {
        content: [{ type: "text", text: "Munim result rejected; перечитай список приложений." }],
      };
    }
    if (call.name === "list_apps") {
      singleWindowPids = parseSingleWindowPids(textContent(event.content));
      status(ctx, "готово");
      return { content: replaceContentRefs(event.content, new Map()) as WrapperResult["content"] };
    } else if (call.name === "screenshot") {
      status(ctx, "изображение готово");
      // The screenshot is a read-only observation, not a new UI-tree generation.
      return { content: event.content as WrapperResult["content"] };
    } else if (call.name === "get_app_state" && call.pid !== undefined) {
      const rawText = textContent(event.content);
      if (!isSingleWindowSnapshot(rawText, call.pid)) {
        tokens.invalidate();
        return {
          content: [
            {
              type: "text",
              text: "Munim snapshot не подтвердил ожидаемый PID и одно окно; обнови состояние приложения.",
            },
          ],
        };
      }
      const backendIds = idsIn(`${rawText}\n${JSON.stringify(event.structuredContent ?? "")}`);
      const issued = tokens.issue(call.pid, backendIds);
      if (!issued) {
        tokens.invalidate();
        return {
          content: [
            {
              type: "text",
              text: "Munim snapshot не прошёл проверку; обнови состояние приложения.",
            },
          ],
        };
      }
      const replacements = new Map(backendIds.map((id, index) => [id, issued.tokens[index]!]));
      const content = replaceContentRefs(event.content, replacements);
      sanitizedSnapshots.add(call.wrapperId);
      status(ctx, "готово");
      // Returning content only intentionally drops raw structuredContent, which may carry eN IDs.
      return { content: content as WrapperResult["content"] };
    } else if (ACTIONS.has(call.name)) {
      status(ctx, "действие отправлено; результат неизвестен");
      return {
        content: [
          {
            type: "text",
            text: "Munim action dispatched; результат неизвестен. Сначала перечитай состояние.",
          },
        ],
      };
    }
    status(ctx, "готово");
    return { content: replaceContentRefs(event.content, new Map()) as WrapperResult["content"] };
  });

  pi.on("agent_settled", (event) => {
    if (!event.aborted) return;
    abortActiveCalls();
  });

  async function nested(
    id: string,
    ctx: ExtensionToolContext,
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<WrapperResult> {
    const wrapper: ActiveWrapper = {
      ...(signal ? { signal } : {}),
      aborted: signal?.aborted ?? false,
    };
    wrapper.onAbort = () => {
      wrapper.aborted = true;
      abortActiveCalls();
    };
    if (signal?.aborted) wrapper.onAbort();
    else signal?.addEventListener("abort", wrapper.onAbort, { once: true });
    active.set(id, wrapper);
    let rawArgs = args;
    try {
      if (ACTIONS.has(name)) {
        if (busy)
          throw new Error("Другой снимок или action ещё выполняется; конкурентный вызов закрыт.");
        const pid = readPid(args);
        const token = args.element_token;
        if (!recoveryGate)
          throw new Error("Нет синхронного durable recovery gate; действие запрещено.");
        if (!pid || !singleWindowPids.has(pid))
          throw new Error("Действие требует PID с последнего отчёта windows=1.");
        if (typeof token !== "string")
          throw new Error("Действие требует opaque token из последнего snapshot.");
        const backendId = tokens.resolve(token, pid);
        if (!backendId) throw new Error("Токен устарел или относится к другому PID.");
        if (name === "type_text" && typeof args.text !== "string")
          throw new Error("Для type_text нужен текст.");
        // Resolve the wrapper token and commit the intent before calling ctx.executeTool,
        // because Pi validates the nested Munim schema before invoking tool_call hooks.
        tokens.invalidate();
        generation += 1;
        let actionId: string;
        try {
          actionId = recoveryGate.beginAction({
            operationId: id,
            pid,
            kind: name as MunimActionKind,
          });
          if (typeof actionId !== "string" || !actionId)
            throw new Error("Recovery gate вернул неверный action ID");
        } catch (error) {
          throw new Error(
            `Recovery gate не сохранил intent; Munim не вызван. ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        const rawActionArgs: Record<string, unknown> = { app: String(pid), element_id: backendId };
        if (name === "type_text") rawActionArgs.text = args.text;
        const prepared: PreparedAction = {
          actionId,
          wrapperId: id,
          aborted: false,
          persisted: false,
          name: name as MunimActionKind,
          pid,
          args: rawActionArgs,
        };
        preparedActions.set(id, prepared);
        busy = `wrapper:${id}`;
        rawArgs = rawActionArgs;
      } else if (name === "get_app_state") {
        const pid = readPid(args);
        if (!pid || !singleWindowPids.has(pid))
          throw new Error("Нужен PID с последнего отчёта windows=1.");
        rawArgs = { app: String(pid) };
      } else if (name === "screenshot") {
        const pid = readPid(args);
        if (!pid || !singleWindowPids.has(pid))
          throw new Error("Screenshot требует PID с последнего отчёта windows=1.");
        if (busy) throw new Error("Другой снимок или action ещё выполняется; screenshot закрыт.");
        preparedScreenshots.set(id, pid);
        busy = `wrapper:${id}`;
        rawArgs = { app: String(pid) };
      }
    } catch (error) {
      const prepared = preparedActions.get(id);
      if (prepared) {
        persistUnknown(recoveryGate, prepared);
        preparedActions.delete(id);
      }
      preparedScreenshots.delete(id);
      if (busy === `wrapper:${id}`) busy = undefined;
      signal?.removeEventListener("abort", wrapper.onAbort);
      active.delete(id);
      throw error;
    }
    try {
      const outcome = await ctx.executeTool(
        `${PREFIX}${name}`,
        rawArgs,
        signal ? { signal } : undefined,
      );
      if (wrapper.aborted || signal?.aborted)
        throw new Error("Munim результат отброшен после Stop; состояние нужно перечитать.");
      if (ACTIONS.has(name)) {
        if (wrapper.aborted || signal?.aborted) throw new Error(`${INVALIDATED} (Stop)`);
        throw new Error(
          `${INVALIDATED}${textContent(outcome.result.content) ? ` ${textContent(outcome.result.content)}` : ""}`,
        );
      }
      if (outcome.isError)
        throw new Error(textContent(outcome.result.content) || `Munim ${name} failed`);
      if (name === "get_app_state") {
        if (!sanitizedSnapshots.has(id))
          throw new Error("Munim snapshot не прошёл guard; необработанный результат отброшен.");
        sanitizedSnapshots.delete(id);
      }
      return outcome.result;
    } finally {
      for (const [callId, lease] of actions)
        if (lease.wrapperId === id) {
          persistUnknown(recoveryGate, lease);
          // Keep the raw-call tombstone and single-flight lock until its tool_result arrives.
          // Stop may return the wrapper early while the native MCP call is still running.
          ignored.add(callId);
        }
      const prepared = preparedActions.get(id);
      if (prepared) {
        persistUnknown(recoveryGate, prepared);
        preparedActions.delete(id);
      }
      if (busy === `wrapper:${id}`) busy = undefined;
      sanitizedSnapshots.delete(id);
      signal?.removeEventListener("abort", wrapper.onAbort);
      active.delete(id);
    }
  }

  const pid = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
  pi.registerTool({
    name: "munim_list_apps",
    label: "Munim: приложения",
    description: "Показать приложения и число их окон.",
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute(id, _params, signal, _update, ctx) {
      return nested(id, ctx, "list_apps", {}, signal);
    },
  });
  pi.registerTool({
    name: "munim_get_app_state",
    label: "Munim: состояние приложения",
    description:
      "Прочитать текущее состояние PID из последнего списка; возвращает snapshot-scoped element_token и изображения.",
    parameters: Type.Object({ pid }, { additionalProperties: false }),
    async execute(id, params, signal, _update, ctx) {
      return nested(id, ctx, "get_app_state", { app: String(params.pid) }, signal);
    },
  });
  pi.registerTool({
    name: "munim_screenshot",
    label: "Munim: снимок экрана",
    description:
      "Сделать скриншот приложения по PID из последнего списка окон. Сохраняет изображение и не обновляет токены элементов.",
    parameters: Type.Object({ pid }, { additionalProperties: false }),
    async execute(id, params, signal, _update, ctx) {
      return nested(id, ctx, "screenshot", { pid: params.pid }, signal);
    },
  });
  pi.registerTool({
    name: "munim_click",
    label: "Munim: нажать элемент",
    description:
      "Нажать один элемент по токену из текущего снимка. Итог всегда считается неизвестным.",
    parameters: Type.Object(
      { pid, element_token: Type.String({ minLength: 1 }) },
      { additionalProperties: false },
    ),
    async execute(id, params, signal, _update, ctx) {
      return nested(
        id,
        ctx,
        "click",
        { pid: params.pid, element_token: params.element_token },
        signal,
      );
    },
  });
  pi.registerTool({
    name: "munim_type_text",
    label: "Munim: ввести текст",
    description:
      "Ввести текст в элемент по токену из текущего снимка. Итог всегда считается неизвестным.",
    parameters: Type.Object(
      { pid, element_token: Type.String({ minLength: 1 }), text: Type.String() },
      { additionalProperties: false },
    ),
    async execute(id, params, signal, _update, ctx) {
      return nested(
        id,
        ctx,
        "type_text",
        { pid: params.pid, element_token: params.element_token, text: params.text },
        signal,
      );
    },
  });
}
