// Ремонт аргументов вызова инструмента (ADR-3, research/00-synthesis.md: «чинить аргументы до валидации»).
// Дешёвые модели присылают JSON строкой, лишнюю обёртку `{"arguments": {...}}`, обрезанные кавычки, пути
// Windows с обратными слэшами в Git Bash. Pi проверяет аргументы до хука tool_call, поэтому чиним раньше —
// в message_end ответа ассистента: Pi подменяет сообщение на месте, и цикл выполняет уже исправленные вызовы.
// Что не починилось — после ошибки валидации одна подсказка с правильной формой вызова.
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { bumpStat } from "./stats.ts";
import { recordEvent } from "./learning-log.ts";
import { intervene } from "./lessons.ts";

interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  description?: string;
}

export interface ToolCallPart {
  type: "toolCall";
  id: string;
  name: string;
  arguments: unknown;
  argumentsError?: string;
}

/** Что было исправлено — для журнала замера. */
export type RepairKind =
  | "json-string"
  | "unclosed"
  | "wrapper"
  | "number-string"
  | "windows-path"
  | "windows-command"
  | "provider-oi";

const WRAPPER_KEYS = ["arguments", "parameters", "args", "input"];
const PATH_KEYS = new Set(["path", "file_path", "filePath", "cwd", "dir", "directory"]);
const RECEIVED = "\n\nReceived arguments:\n";

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Закрывает строку и скобки, оборванные в конце (`{"path": "a.txt` → `{"path": "a.txt"}`). */
export function closeUnterminated(json: string): string {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const ch of json) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if ((ch === "}" || ch === "]") && stack.at(-1) === ch) stack.pop();
  }
  let out = json.replace(/\s+$/, "");
  if (inString) out += escaped ? '\\"' : '"';
  out = out.replace(/,\s*$/, "");
  return out + stack.reverse().join("");
}

/** Разбор текста аргументов: обычный JSON, JSON внутри строки, оборванный в конце. */
export function parseArgumentsText(
  raw: string,
): { value: Record<string, unknown>; kinds: RepairKind[] } | undefined {
  const attempts: [string, RepairKind[]][] = [
    [raw, []],
    [closeUnterminated(raw), ["unclosed"]],
  ];
  for (const [text, kinds] of attempts) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    if (typeof parsed === "string") {
      const inner = parseArgumentsText(parsed);
      if (inner) return { value: inner.value, kinds: [...kinds, "json-string", ...inner.kinds] };
      continue;
    }
    if (isObject(parsed)) return { value: parsed, kinds };
  }
  return undefined;
}

function types(schema: JsonSchema | undefined): string[] {
  if (!schema?.type) return [];
  return Array.isArray(schema.type) ? schema.type : [schema.type];
}

/** `C:\Users\me` вне кавычек в Git Bash теряет обратные слэши: делаем `C:/Users/me`. */
export function fixWindowsPathsInCommand(command: string): string {
  let out = "";
  let quote: string | undefined;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      if (ch === quote) quote = undefined;
      out += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      out += ch;
      continue;
    }
    const prev = i === 0 ? " " : command[i - 1]!;
    const token = /^[A-Za-z]:\\[^\s'"|&;<>()]*/.exec(command.slice(i));
    if (token && /[\s=(]/.test(prev)) {
      out += token[0].replace(/\\/g, "/");
      i += token[0].length - 1;
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Чинит один вызов. undefined — чинить нечего (или не вышло). `platform` — для путей Windows: на Linux и macOS
 * обратный слэш в пути бывает законным, там его не трогаем.
 */
export function repairToolCall(
  call: ToolCallPart,
  schema: JsonSchema | undefined,
  platform: NodeJS.Platform = process.platform,
): { call: ToolCallPart; kinds: RepairKind[] } | undefined {
  const kinds: RepairKind[] = [];
  let args: unknown = call.arguments;
  let error = call.argumentsError;

  if (error) {
    const at = error.indexOf(RECEIVED);
    const raw = at >= 0 ? error.slice(at + RECEIVED.length) : undefined;
    const parsed = raw === undefined ? undefined : parseArgumentsText(raw);
    if (!parsed) return undefined;
    args = parsed.value;
    error = undefined;
    kinds.push(...parsed.kinds);
  } else if (typeof args === "string") {
    const parsed = parseArgumentsText(args);
    if (!parsed) return undefined;
    args = parsed.value;
    kinds.push("json-string", ...parsed.kinds);
  }
  if (!isObject(args)) return undefined;
  const given = args;

  const props = schema?.properties ?? {};
  // {"arguments": {...}} или {"name": "bash", "arguments": {...}}: обёртка, которой нет в схеме.
  const keys = Object.keys(given);
  const wrapper = WRAPPER_KEYS.find((k) => k in given && !(k in props));
  if (
    wrapper &&
    keys.every((k) => k === wrapper || (k === "name" && !("name" in props))) &&
    (isObject(given[wrapper]) || typeof given[wrapper] === "string")
  ) {
    const inner = given[wrapper];
    const value = typeof inner === "string" ? parseArgumentsText(inner)?.value : inner;
    if (isObject(value)) {
      args = value;
      kinds.push("wrapper");
    }
  }

  const fixed: Record<string, unknown> = { ...(args as Record<string, unknown>) };
  for (const [key, value] of Object.entries(fixed)) {
    const t = types(props[key]);
    if (typeof value === "string" && (t.includes("number") || t.includes("integer"))) {
      const n = Number(value.trim());
      if (
        value.trim() !== "" &&
        Number.isFinite(n) &&
        (!t.includes("integer") || Number.isInteger(n))
      ) {
        fixed[key] = n;
        kinds.push("number-string");
      }
    }
    if (
      platform === "win32" &&
      typeof value === "string" &&
      PATH_KEYS.has(key) &&
      value.includes("\\")
    ) {
      fixed[key] = value.replace(/\\/g, "/");
      kinds.push("windows-path");
    }
  }
  if (platform === "win32" && call.name === "bash" && typeof fixed.command === "string") {
    const command = fixWindowsPathsInCommand(fixed.command);
    if (command !== fixed.command) {
      fixed.command = command;
      kinds.push("windows-command");
    }
  }

  if (kinds.length === 0) return undefined;
  const { argumentsError: _dropped, ...rest } = call;
  return {
    call: { ...rest, arguments: fixed, ...(error ? { argumentsError: error } : {}) },
    kinds,
  };
}

/**
 * Канал kimi-k3.1-pro на шлюзе переписывает «OpenAI» в «[OI]» внутри аргументов вызовов (проба шлюза 4/4, DIARY 24.10:
 * «[OI]-формат», «[OI] SDK»; в тексте ответа слово целое). Код пользователя с `import openai` портился бы на записи.
 * Только kimi и только этот токен. У edit старый текст не трогаем, если файл уже содержит «[OI]» (записан до
 * починки): иначе oldText перестанет совпадать.
 */
export const PROVIDER_OI = "[OI]";
export const KIMI_MODEL = /kimi/i;

export function restoreProviderOi(
  call: ToolCallPart,
  cwd: string | undefined,
): { call: ToolCallPart; n: number } | undefined {
  if (!isObject(call.arguments) || !JSON.stringify(call.arguments).includes(PROVIDER_OI))
    return undefined;
  const args = call.arguments;
  let keepOld = false;
  if (call.name === "edit" && typeof args.path === "string" && cwd) {
    try {
      keepOld = readFileSync(
        isAbsolute(args.path) ? args.path : join(cwd, args.path),
        "utf8",
      ).includes(PROVIDER_OI);
    } catch {
      keepOld = false;
    }
  }
  let n = 0;
  const walk = (v: unknown, key?: string): unknown => {
    if (typeof v === "string") {
      if (keepOld && key === "oldText") return v;
      const parts = v.split(PROVIDER_OI);
      n += parts.length - 1;
      return parts.join("OpenAI");
    }
    if (Array.isArray(v)) return v.map((x) => walk(x, key));
    if (isObject(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
    return v;
  };
  const fixed = walk(args);
  return n ? { call: { ...call, arguments: fixed }, n } : undefined;
}

/** Правильная форма вызова из схемы: `{"path": "<строка>", "offset": <число>}`. */
export function callShape(name: string, schema: JsonSchema | undefined): string {
  const props = schema?.properties ?? {};
  const required = new Set(schema?.required ?? []);
  const keys = Object.keys(props).filter((k) => required.has(k));
  const shown = keys.length > 0 ? keys : Object.keys(props).slice(0, 3);
  const example = shown
    .map((k) => {
      const t = types(props[k])[0];
      const v =
        t === "number" || t === "integer"
          ? "<число>"
          : t === "boolean"
            ? "true"
            : t === "array"
              ? "[…]"
              : t === "object"
                ? "{…}"
                : '"<строка>"';
      return `"${k}": ${v}`;
    })
    .join(", ");
  return `${name} {${example}}`;
}

export function validationHint(name: string, schema: JsonSchema | undefined): string {
  return (
    `[Подсказка харнесса: правильная форма вызова — ${callShape(name, schema)}. Аргументы — один объект JSON: ` +
    "без обёртки «arguments», без JSON внутри строки, числа — числами, все кавычки закрыты.]"
  );
}

const VALIDATION_ERROR = /^(?:Validation failed for tool|Invalid arguments for tool) "([^"]+)"/;

interface MessageLike {
  role: string;
  content?: unknown;
  toolName?: string;
  isError?: boolean;
  model?: string;
  responseModel?: string;
}

export function installArgRepair(pi: ExtensionAPI): void {
  const hinted = new Set<string>();
  const schemaOf = (name: string): JsonSchema | undefined => {
    try {
      return pi.getAllTools().find((t) => t.name === name)?.parameters as JsonSchema | undefined;
    } catch {
      return undefined;
    }
  };

  pi.on("before_agent_start", (event) => {
    if (event.messageType === "user") hinted.clear();
  });

  pi.on("message_end", (event, ctx) => {
    const message = event.message as unknown as MessageLike;
    let session = "";
    try {
      session = ctx.sessionManager.getSessionId();
    } catch {
      // без сессии — общий счёт
    }

    if (message.role === "assistant" && Array.isArray(message.content)) {
      let changed = false;
      const kimi = KIMI_MODEL.test(`${message.model ?? ""} ${message.responseModel ?? ""}`);
      const content = (message.content as { type: string }[]).map((part) => {
        if (part.type !== "toolCall") return part;
        const original = part as unknown as ToolCallPart;
        let call = original;
        const repaired = repairToolCall(call, schemaOf(call.name));
        if (repaired) {
          changed = true;
          call = repaired.call;
          for (const kind of repaired.kinds) {
            bumpStat(session, `repair:${kind}`);
            recordEvent(ctx, { kind: "repair", tool: call.name, sig: `repair:${kind}` });
          }
        }
        const oi = kimi ? restoreProviderOi(call, ctx.cwd) : undefined;
        if (oi) {
          changed = true;
          call = oi.call;
          bumpStat(session, "repair:provider-oi");
          recordEvent(ctx, { kind: "repair", tool: call.name, sig: "repair:provider-oi", n: oi.n });
        }
        return call === original ? part : call;
      });
      return changed
        ? { message: { ...event.message, content } as typeof event.message }
        : undefined;
    }

    if (message.role === "toolResult" && message.isError && Array.isArray(message.content)) {
      const parts = message.content as { type: string; text?: string }[];
      const text = parts.map((p) => (p.type === "text" ? (p.text ?? "") : "")).join("");
      const name = VALIDATION_ERROR.exec(text)?.[1];
      if (!name) return undefined;
      bumpStat(session, "validation-error");
      const tip = intervene(ctx, {
        kind: "validation.error",
        tool: name,
        sig: `validation:${name}`,
      });
      // Одна подсказка на инструмент за сообщение пользователя.
      const first = !hinted.has(name);
      hinted.add(name);
      const extra = `${first ? `\n\n${validationHint(name, schemaOf(name))}` : ""}${tip}`;
      if (!extra) return undefined;
      const hint = { type: "text" as const, text: extra };
      return { message: { ...event.message, content: [...parts, hint] } as typeof event.message };
    }
    return undefined;
  });
}
