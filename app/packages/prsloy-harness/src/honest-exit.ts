// Честный выход (research/24 §4.2, этап H-1) — дорожка harness: инструмент `report_blocker` и текст T1 в каждом
// возврате гейта. Блокер снимает возвраты, только если после первого красного была правка и причину подтвердил код.
// Флаг "honestExit" (по умолчанию выкл.). Здесь «трубы» (§2): точка подключения, реализация — H-1.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ResolvedOptions } from "./options.ts";

export function installHonestExit(_pi: ExtensionAPI, _opts: ResolvedOptions): void {}
