// Слова и факты (research/24 §4.1, этап H-2) — дорожка harness: «проверил / тесты проходят» без прогона харнесса,
// заглушки по edit/write и по диффу хода, статус хода кодом. Флаг "claimCheck" (по умолчанию выкл.). Здесь «трубы».
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ResolvedOptions } from "./options.ts";

export function installClaimCheck(_pi: ExtensionAPI, _opts: ResolvedOptions): void {}
