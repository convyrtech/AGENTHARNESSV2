// Установка пакетов упала из-за сети (features, «несчастливый первый час»): npm / pip без интернета. Без карточки
// человек видит только слова модели. Карточка «Не скачались пакеты: нет связи» с кнопкой «Повторить» (ui) — одна
// на сообщение пользователя; модели — строка в результате: не обходить, сказать человеку.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { recordEvent } from "./learning-log.ts";
import type { ResolvedOptions } from "./options.ts";
import { appendText, contentText, keepStructured, showCard } from "./text.ts";

export const INSTALL_OFFLINE_TYPE = "prsloy-harness.install-offline";
export const INSTALL_OFFLINE_CARD = "Не скачались пакеты: нет связи";
export const INSTALL_OFFLINE_NOTE =
  "[Пакеты не скачались: нет связи с интернетом. Не ищи обходы (другие зеркала, ручное скачивание, код вместо пакета) — коротко скажи пользователю, что нужен интернет, и остановись. Он нажмёт «Повторить», когда связь будет.]";

/** Команда ставит пакеты: npm/pnpm/yarn/bun install|add|ci, pip/uv/poetry/pipx install|add|sync. */
const INSTALLS =
  /\b(?:(?:npm|pnpm|yarn|bun)\s+(?:i|install|add|ci)\b|(?:pip3?|uv\s+pip|pipx)\s+install\b|python3?\s+-m\s+pip\s+install\b|(?:poetry|uv)\s+(?:add|sync|install)\b|npx\s+-y\b)|(?:^|[\\/])pip(?:3)?(?:\.exe)?\s+install\b/;

/** Ошибка сети, а не пакета: DNS, таймаут соединения, сокет, «нет связи» у pip. */
const NETWORK_ERROR =
  /\b(?:ENOTFOUND|ETIMEDOUT|ECONNREFUSED|ECONNRESET|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|ERR_SOCKET\w*|ERR_INTERNET_DISCONNECTED)\b|Could not resolve host|Failed to establish a new connection|Temporary failure in name resolution|Name or service not known|getaddrinfo failed|NewConnectionError|network is unreachable|request to https?:\/\/\S+ failed, reason:/i;

export function isOfflineInstall(command: string, output: string): boolean {
  return INSTALLS.test(command) && NETWORK_ERROR.test(output);
}

export function installInstallOffline(pi: ExtensionAPI, opts: ResolvedOptions): void {
  if (opts.profile !== "code") return;
  let shown = false;
  pi.on("before_agent_start", (event) => {
    if (event.messageType === "user") shown = false;
  });
  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "bash" || !event.isError) return undefined;
    const command = (event.input as { command?: unknown }).command;
    if (typeof command !== "string") return undefined;
    const output = contentText(event.content);
    if (!isOfflineInstall(command, output)) return undefined;
    recordEvent(ctx, { kind: "install.offline", tool: "bash", sig: "install:offline" });
    if (!shown) {
      shown = true;
      await showCard(pi, INSTALL_OFFLINE_TYPE, INSTALL_OFFLINE_CARD, {
        command: command.slice(0, 300),
        retry: true,
      });
    }
    return { content: appendText(event.content, INSTALL_OFFLINE_NOTE), ...keepStructured(event) };
  });
}
