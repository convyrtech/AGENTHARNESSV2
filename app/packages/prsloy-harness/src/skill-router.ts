import { readdirSync } from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface SkillRoute {
  skill: string;
  confidence: number;
}

export interface RouterSkill {
  id: string;
  description: string;
}

export function routerPrompt(request: string, skills: RouterSkill[], hints: string[]): string {
  return [
    "Choose at most one skill that directly helps with the user's request. Project facts are weak evidence; do not infer a skill from a file extension alone. Choose none if no skill clearly fits or the request is ambiguous.",
    'Return only JSON: {"skill":"<id>"|"none","confidence":0..1}.',
    "Skills:",
    ...skills.map((skill) => `- ${skill.id}: ${skill.description}`),
    "Project facts:",
    ...(hints.length ? hints.map((hint) => `- ${hint}`) : ["- (none)"]),
    "User request:",
    request.trim() || "(empty)",
  ].join("\n");
}

export function parseRoute(text: string, ids: string[]): SkillRoute {
  try {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) return { skill: "none", confidence: 0 };
    const value = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    const confidence = value.confidence;
    if (
      typeof value.skill !== "string" ||
      typeof confidence !== "number" ||
      !Number.isFinite(confidence) ||
      confidence < 0 ||
      confidence > 1
    )
      return { skill: "none", confidence: 0 };
    if (value.skill === "none") return { skill: "none", confidence };
    if (!ids.includes(value.skill)) return { skill: "none", confidence: 0 };
    return { skill: value.skill, confidence };
  } catch {
    return { skill: "none", confidence: 0 };
  }
}

export function projectHints(cwd: string, maxHints = 8): string[] {
  try {
    const entries = readdirSync(cwd, { withFileTypes: true });
    const files = entries.filter((entry) => entry.isFile());
    const extensions = [
      ...new Set(
        files
          .map((entry) =>
            /^\.[^.]+/.test(entry.name) && !entry.name.includes(".", 1)
              ? "[dotfile]"
              : entry.name.includes(".")
                ? `.${entry.name.split(".").pop()!.toLowerCase()}`
                : "[no extension]",
          )
          .filter(Boolean),
      ),
    ].sort();
    const markers = ["package.json", "pyproject.toml", "requirements.txt", "index.html"]
      .filter((name) => entries.some((entry) => entry.isFile() && entry.name === name))
      .map((name) => `${name} present`);
    const hints = [`${files.length} top-level files`];
    if (extensions.length) hints.push(`Extensions: ${extensions.slice(0, 5).join(", ")}`);
    hints.push(...markers);
    return hints.slice(0, Math.max(0, maxHints));
  } catch {
    return [];
  }
}

export interface RouteSkillOptions {
  model?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export async function routeSkill(
  request: string,
  skills: RouterSkill[],
  hints: string[],
  ctx: ExtensionContext,
  options: RouteSkillOptions = {},
): Promise<SkillRoute> {
  const none: SkillRoute = { skill: "none", confidence: 0 };
  try {
    const modelId = options.model ?? "deepseek-v4.1-flash-1017";
    const slash = modelId.indexOf("/");
    const provider = slash > 0 ? modelId.slice(0, slash) : (ctx.model?.provider ?? "prsloy");
    const id = slash > 0 ? modelId.slice(slash + 1) : modelId;
    if (!provider) return none;
    const model = ctx.modelRegistry.find(provider, id);
    if (!model) return none;
    const complete = ctx.modelRegistry.complete.bind(ctx.modelRegistry);
    const signals = [AbortSignal.timeout(options.timeoutMs ?? 15_000)];
    if (ctx.signal) signals.push(ctx.signal);
    const reply = await complete(
      model,
      {
        messages: [
          { role: "user", content: routerPrompt(request, skills, hints), timestamp: Date.now() },
        ],
      },
      // Думающим моделям нужен запас: рассуждение тоже тратит лимит.
      { signal: AbortSignal.any(signals), maxTokens: 400 },
    );
    if (reply.stopReason === "error" || reply.stopReason === "aborted") return none;
    return parseRoute(
      reply.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
      skills.map((skill) => skill.id),
    );
  } catch {
    return none;
  }
}

export function skillName(id: string): string {
  const names: Record<string, string> = {
    "canvas-game": "игру на canvas",
    "excel-csv": "Excel и CSV",
    "explain-project": "разбор проекта",
    "fix-code": "починку кода",
    "python-windows": "Python на Windows",
    "site-landing": "сайт-визитку",
    "telegram-bot": "Telegram-бота",
    "web-scraper": "парсер сайта",
  };
  return names[id] ?? id;
}
