// Память сама, из слов пользователя (research/24 §3, этапы M-2…M-5) — дорожка core. Здесь «трубы» (§2): тип
// экстрактора и точка подключения; реализацию пишет core в этом файле и в src/memory*.ts.
// Флаг "autoMemory": "off" (по умолчанию) | "shadow" (кандидаты, в промпт ничего) | true (запись).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ResolvedOptions } from "./options.ts";

/**
 * Вызов модели-экстрактора: промпт → сырой ответ (JSON операций, research/24 §3.4). В бенче — сценарий из
 * `fake.json` задачи (ключ "extractor"), в приложении — дешёвая модель шлюза вне хода (M-sp).
 */
export type ExtractorFn = (prompt: string) => Promise<string>;

export interface AutoMemoryOptions {
  /** Подменить модель экстрактора (тесты, бенч --fake). */
  extract?: ExtractorFn;
}

/** Точка подключения: пока ничего не делает (core, M-3). */
export function installAutoMemory(_pi: ExtensionAPI, _opts: ResolvedOptions): void {}
