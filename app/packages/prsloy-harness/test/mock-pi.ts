// Мок ExtensionAPI: копирует семантику ExtensionRunner из Pi 1.4 (runner.js) для tool_call,
// tool_result (цепочка), turn_end/agent_before_settle (записи + continue) и прочих событий.
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

type Handler = (event: any, ctx: ExtensionContext) => unknown;

export interface ToolResultInput {
  toolName: string;
  toolCallId?: string;
  input?: Record<string, unknown>;
  text?: string;
  isError?: boolean;
  details?: unknown;
  structuredContent?: unknown;
}

export interface ToolResultOutput {
  text: string;
  isError: boolean;
  structuredContent: unknown;
  modified: boolean;
}

export class MockPi {
  readonly handlers = new Map<string, Handler[]>();
  readonly tools = new Map<string, ToolDefinition<any, any, any>>();
  activeTools = ["read", "bash", "edit", "write"];
  aborted = 0;
  #nextId = 1;

  readonly ctx: ExtensionContext;

  constructor(cwd = process.cwd(), model?: { cost?: Record<string, number> }) {
    this.ctx = {
      cwd,
      mode: "print",
      hasUI: false,
      model,
      signal: undefined,
      abort: () => {
        this.aborted += 1;
      },
      ui: { notify() {}, setStatus() {} },
      sessionManager: { getSessionId: () => "test-session", getSessionFile: () => undefined },
      isIdle: () => true,
      hasPendingMessages: () => false,
    } as unknown as ExtensionContext;
  }

  get api(): ExtensionAPI {
    const self = this;
    return {
      on(name: string, handler: Handler) {
        const list = self.handlers.get(name) ?? [];
        list.push(handler);
        self.handlers.set(name, list);
        return () => {};
      },
      registerTool(tool: ToolDefinition<any, any, any>) {
        self.tools.set(tool.name, tool);
      },
      getActiveTools: () => self.activeTools,
      appendEntry() {},
      sendMessage() {},
    } as unknown as ExtensionAPI;
  }

  async emit(name: string, event: Record<string, unknown>): Promise<unknown[]> {
    const out: unknown[] = [];
    for (const handler of this.handlers.get(name) ?? []) out.push(await handler({ type: name, ...event }, this.ctx));
    return out;
  }

  async userPrompt(prompt = "задача"): Promise<void> {
    await this.emit("before_agent_start", {
      messageType: "user",
      prompt,
      systemPrompt: "",
      systemPromptOptions: { sections: {} },
    });
  }

  /** Как emitToolCall: первый block останавливает цепочку, input мутируется на месте. */
  async toolCall(
    toolName: string,
    input: Record<string, unknown>,
    toolCallId = `call-${this.#nextId++}`,
  ): Promise<{ block?: boolean; reason?: string; terminate?: boolean } | undefined> {
    const event = { type: "tool_call", toolName, toolCallId, input };
    for (const handler of this.handlers.get("tool_call") ?? []) {
      const result = (await handler(event, this.ctx)) as { block?: boolean } | undefined;
      if (result?.block) return result;
    }
    return undefined;
  }

  /** Как emitToolResult: каждый обработчик видит изменения предыдущих. */
  async toolResult(input: ToolResultInput): Promise<ToolResultOutput> {
    const event: Record<string, unknown> = {
      type: "tool_result",
      toolName: input.toolName,
      toolCallId: input.toolCallId ?? `call-${this.#nextId++}`,
      input: input.input ?? {},
      content: [{ type: "text", text: input.text ?? "" }],
      details: input.details,
      isError: input.isError ?? false,
    };
    if (input.structuredContent !== undefined) event.structuredContent = input.structuredContent;
    let modified = false;
    for (const handler of this.handlers.get("tool_result") ?? []) {
      const result = (await handler(event, this.ctx)) as Record<string, unknown> | undefined;
      if (!result) continue;
      if (result.content !== undefined) {
        event.content = result.content;
        if (result.structuredContent === undefined) delete event.structuredContent;
        modified = true;
      }
      if (result.structuredContent !== undefined) event.structuredContent = result.structuredContent;
      if (result.isError !== undefined) event.isError = result.isError;
    }
    const content = event.content as { type: string; text?: string }[];
    return {
      text: content.map((part) => part.text ?? "").join("\n"),
      isError: event.isError as boolean,
      structuredContent: event.structuredContent,
      modified,
    };
  }

  /** Вызов + результат одной строкой, как это делает agent-loop. */
  async call(toolName: string, input: Record<string, unknown>, text: string, isError = false) {
    const id = `call-${this.#nextId++}`;
    const blocked = await this.toolCall(toolName, input, id);
    if (blocked) return { blocked, result: undefined };
    return { blocked: undefined, result: await this.toolResult({ toolName, toolCallId: id, input, text, isError }) };
  }

  async assistantMessage(message: Record<string, unknown>): Promise<void> {
    await this.emit("message_end", { message: { role: "assistant", content: [], stopReason: "stop", ...message } });
  }

  /** Как turn_end/agent_before_settle: записи копятся, continue — от любого обработчика. */
  async boundary(name: "turn_end" | "agent_before_settle", event: Record<string, unknown> = {}) {
    const entries: unknown[] = [];
    let cont = false;
    for (const handler of this.handlers.get(name) ?? []) {
      const result = (await handler({ type: name, entries, continue: cont, ...event }, this.ctx)) as
        | { entries?: unknown[]; continue?: boolean }
        | undefined;
      if (result?.entries) entries.push(...result.entries);
      if (result?.continue) cont = true;
    }
    return { entries, continue: cont };
  }

  tool(name: string): ToolDefinition<any, any, any> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`tool ${name} is not registered`);
    return tool;
  }
}
