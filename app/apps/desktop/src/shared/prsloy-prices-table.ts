/**
 * Retail PRSLOY gateway prices, in rubles per 1M tokens.
 *
 * Generated from the public GET https://prsloy.online/api/pricing on 2026-10-29.
 * The live reader refreshes this data at startup and hourly. This snapshot is only the
 * first-launch/offline fallback. Models billed per call rather than per token are excluded.
 * Do not infer missing prices: an unknown model stays unpriced and shows no money.
 */
import type { RubPricePerM } from "./prsloy-prices.ts";

export const PRSLOY_PRICE_TABLE_SNAPSHOT: Readonly<Record<string, RubPricePerM>> = {
  "qwen3.8-max": {
    input: 4.3,
    cacheRead: 1.15,
    cacheWrite: 5.375,
    output: 13,
  },
  "deepseek-v4.1-flash-1017": {
    input: 1.04,
    cacheRead: 0.05,
    cacheWrite: 1.3,
    output: 4.1,
  },
  "gpt-6-astra": {
    input: 66,
    cacheRead: 6.6,
    cacheWrite: 82.5,
    output: 330,
  },
  "qwen3.8-flash": {
    input: 2.75,
    cacheRead: 0.27,
    cacheWrite: 3.4375,
    output: 8,
  },
  "glm-5.3": {
    input: 4.4,
    cacheRead: 0.81,
    cacheWrite: 5.5,
    output: 14,
  },
  "gpt-6.1-terra": {
    input: 15,
    cacheRead: 0.76,
    cacheWrite: 18.75,
    output: 76,
  },
  "claude-fable-5": {
    input: 95,
    cacheRead: 9.5,
    cacheWrite: 118.75,
    output: 474,
  },
  "kimi-k3": {
    input: 19,
    cacheRead: 1.9,
    cacheWrite: 23.75,
    output: 96,
  },
  "minimax-m3.1-flash": {
    input: 4.5,
    cacheRead: 0.45,
    cacheWrite: 5.625,
    output: 18,
  },
  "gemini-4-argon": {
    input: 16,
    cacheRead: 1.6,
    cacheWrite: 20,
    output: 80,
  },
  "gpt-6.1-sol": {
    input: 11,
    cacheRead: 1.1,
    cacheWrite: 13.75,
    output: 55,
  },
  "grok-4.7": {
    input: 6,
    cacheRead: 1.5,
    cacheWrite: 7.5,
    output: 18,
  },
  "claude-fable-5-1": {
    input: 85,
    cacheRead: 2.1,
    cacheWrite: 106.25,
    output: 420,
  },
  "gemini-3.8-flash": {
    input: 4.7,
    cacheRead: 0.47,
    cacheWrite: 5.875,
    output: 23,
  },
  "mimo-v2.6-pro": {
    input: 31,
    cacheRead: 0.25,
    cacheWrite: 38.75,
    output: 61,
  },
  "claude-opus-5-5": {
    input: 38,
    cacheRead: 1.9,
    cacheWrite: 47.5,
    output: 190,
  },
  "kimi-k3.1-pro": {
    input: 26,
    cacheRead: 6.5,
    cacheWrite: 32.5,
    output: 130,
  },
};
