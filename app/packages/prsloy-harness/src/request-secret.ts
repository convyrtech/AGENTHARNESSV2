// Агент просит ключ формой, а не в чате (research/19 §1.3). Значение пишет расширение само в `<проект>/.env`,
// дописывает `.env` в `.gitignore` и прячет значение из всего, что видит модель. Модели — только имя.
//
// Описание инструмента и параметров — по OpenHands Agent Canvas `src/api/request-secret-client-tool.ts`
// (коммит b185939), MIT, © 2025 OpenHands contributors; изменено PRSLOY: ответ приходит сразу в результате
// вызова, ключ хранится в .env проекта.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { recordEvent } from "./learning-log.ts";
import type { ResolvedOptions } from "./options.ts";
import { rememberSecretValue } from "./secret-scrub.ts";

/**
 * Метка для окна ввода: placeholder `secret:NAME`. По ней рендерер включает скрытое поле и ссылку «Где взять»
 * (Pi-диалог скрытого поля не умеет — `ExtensionUIDialogOptions` только `signal` и `timeout`).
 */
export const SECRET_PLACEHOLDER_PREFIX = "secret:";

const NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

const DESCRIPTION = `Ask the user to securely provide a secret you need (an API key, bot token, password or other credential) through a form, not in the chat.

Call this when a task needs a credential the project does not have yet, for example a Telegram bot token. Never ask the user to paste a secret into the chat, and never put a secret value in this tool's arguments.

The value is saved to the project's .env file as NAME=value (.env is added to .gitignore) and is never shown to you. Read it from the environment in code (process.env.NAME, os.environ["NAME"], python-dotenv / dotenv); never print, echo or hard-code it. One call per missing secret; if the user declines, do not ask again unless they ask you to.`;

export const SECRET_TEXT = {
  title: (reason: string) => `Нужен ключ: ${reason}`,
  saved: (name: string) =>
    `Ключ сохранён в .env как ${name}. Читай его из окружения (process.env.${name}, os.environ["${name}"]); не печатай и не вставляй в код.`,
  declined: (name: string) =>
    `Пользователь не ввёл ключ ${name}. Не проси его в чате и не вызывай этот инструмент снова, пока пользователь сам не попросит. Сделай, что можно без ключа, и коротко скажи, что без него не заработает.`,
  noUi: (name: string) =>
    `Окно для ключа ${name} сейчас не показать. Не проси ключ в чате: скажи пользователю, что нужен ключ ${name} и зачем, и остановись.`,
  badName:
    "Имя ключа: латинские буквы, цифры и _, начинается с буквы, до 64 знаков (например TELEGRAM_BOT_TOKEN).",
} as const;

function envLine(name: string, value: string): string {
  return /^[A-Za-z0-9_\-.:/+=@]+$/.test(value)
    ? `${name}=${value}`
    : `${name}=${JSON.stringify(value)}`;
}

/** Записать NAME=value в .env (заменить строку, если уже есть) и .env — в .gitignore. */
export function saveToEnv(cwd: string, name: string, value: string): void {
  const envPath = join(cwd, ".env");
  const old = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  const lines = old ? old.replace(/\r?\n$/, "").split(/\r?\n/) : [];
  const at = lines.findIndex((l) => l.replace(/^\s*export\s+/, "").startsWith(`${name}=`));
  if (at >= 0) lines[at] = envLine(name, value);
  else lines.push(envLine(name, value));
  writeFileSync(envPath, `${lines.join("\n")}\n`, { mode: 0o600 });

  const ignorePath = join(cwd, ".gitignore");
  const ignore = existsSync(ignorePath) ? readFileSync(ignorePath, "utf8") : "";
  const covered = ignore
    .split(/\r?\n/)
    .some((l) => ["/.env", ".env", ".env*", "*.env", ".env.*"].includes(l.trim()));
  if (!covered)
    writeFileSync(ignorePath, `${ignore}${ignore && !ignore.endsWith("\n") ? "\n" : ""}.env\n`);
}

export function installRequestSecret(pi: ExtensionAPI, opts: ResolvedOptions): void {
  if (opts.profile !== "code") return;
  pi.registerTool({
    name: "request_secret",
    label: "ключ",
    description: DESCRIPTION,
    promptSnippet: "Ask the user for an API key or token through a form (never in the chat)",
    parameters: Type.Object({
      name: Type.String({
        description:
          "Environment variable name for the secret, e.g. 'TELEGRAM_BOT_TOKEN'. Starts with a letter; letters, digits and underscores only; at most 64 characters.",
      }),
      reason: Type.String({
        description:
          "One sentence in Russian shown to the user: what the key is for and where to get it (e.g. «Токен бота — его выдаёт @BotFather в Telegram»).",
      }),
    }),
    async execute(_id, params, signal, _onUpdate, ctx: ExtensionContext) {
      const name = params.name.trim();
      const text = (t: string, saved: boolean, isError = false) => ({
        content: [{ type: "text" as const, text: t }],
        details: { name, saved },
        ...(isError ? { isError: true } : {}),
      });
      if (!NAME.test(name)) return text(SECRET_TEXT.badName, false, true);
      if (!ctx.hasUI) {
        recordEvent(ctx, { kind: "secret.declined", tool: "request_secret", sig: "secret:no-ui" });
        return text(SECRET_TEXT.noUi(name), false);
      }
      const value = (
        await ctx.ui.input(
          SECRET_TEXT.title(params.reason.trim()),
          `${SECRET_PLACEHOLDER_PREFIX}${name}`,
          signal ? { signal } : {},
        )
      )?.trim();
      if (!value || /[\r\n]/.test(value)) {
        recordEvent(ctx, { kind: "secret.declined", tool: "request_secret", sig: "secret" });
        return text(SECRET_TEXT.declined(name), false);
      }
      rememberSecretValue(value, name);
      saveToEnv(ctx.cwd, name, value);
      recordEvent(ctx, { kind: "secret.saved", tool: "request_secret", sig: "secret" });
      return text(SECRET_TEXT.saved(name), true);
    },
  });
}
