// Страж старых тестов (research/24 §4.1 H2/H3, этап H-1) — дорожка harness: снимок проверки на начало хода, прогон
// исходной команды во временной копии, сигнатуры подмены (`process.env.CI`, `NODE_ENV==='test'`…), правка по
// просьбе пользователя (§4.3). Флаг "testGuard" (по умолчанию выкл. до ответа владельца). Здесь «трубы» (§2).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ResolvedOptions } from "./options.ts";

export function installTestGuard(_pi: ExtensionAPI, _opts: ResolvedOptions): void {}
