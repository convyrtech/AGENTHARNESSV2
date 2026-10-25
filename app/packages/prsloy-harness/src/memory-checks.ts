// Проверки записи памяти, общие для инструмента в ходе (memory.ts) и перепроверки старых записей при загрузке
// (memory-store.ts): секреты и команды вместо фактов.
import { scrubSecrets } from "./secret-scrub.ts";

const SENSITIVE =
  /(парол|password|passwd|пин-?код|\bpin\b|cvv|cvc|токен|token|api[ _-]?key|ключ доступа|секретн|кодовое слово|логин и пароль)/i;
const CARD = /\b(?:\d[ -]?){13,19}\b/;

/** Пароль, ключ, номер карты — в тексте записи или в цитате. */
export function looksSensitive(...texts: string[]): boolean {
  return texts.some((t) => scrubSecrets(t).count > 0 || SENSITIVE.test(t) || CARD.test(t));
}

// Скан угроз по образцу Hermes (research/05-hermes.md:192): команды вместо фактов.
const THREATS: RegExp[] = [
  /https?:\/\/\S+/i, // память — факты о человеке и проекте, не адреса для отправки
  /ignore (?:all |the )?(?:previous|above)|игнорируй (?:все )?(?:предыдущ|прошл)/i,
  /<\s*\/?\s*(?:system|instructions?|prompt)/i,
  /[​-‏⁠-⁤﻿‪-‮]/,
  /[A-Za-z0-9+/]{40,}={0,2}/, // base64-блок
  /agents\.md|claude\.md|authorized_keys|\.ssh|\.env\b/i,
  /(?:отправ|пересыл|send|upload|post)\S*\s.*(?:ключ|key|токен|token|парол|password|файл|file)/i,
];

export function looksLikeThreat(text: string): boolean {
  return THREATS.some((re) => re.test(text));
}
