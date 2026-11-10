import { messageCostRub } from "./budget.ts";

type Rates = { input: number; output: number; cacheRead: number; cacheWrite: number };
type Usage = Parameters<typeof messageCostRub>[0];

/** Catalogue estimate, not a guarantee about the provider's final bill. */
export class DelegationBudget {
  spent = 0;
  pending = 0;
  unknown = false;
  exceeded = false;
  calls = 0;

  constructor(
    readonly limit: number,
    readonly attempts: number,
    readonly reviewReserve: number,
  ) {
    if (
      !Number.isFinite(limit) ||
      limit <= 0 ||
      !Number.isInteger(attempts) ||
      attempts < 1 ||
      !Number.isFinite(reviewReserve) ||
      reviewReserve < 0
    )
      throw new Error("Invalid delegation budget");
  }

  reserve(payload: unknown, rates: Rates, maxOutput: number, review = false): void {
    if (this.pending || this.unknown) throw new Error("Previous usage is unresolved");
    if (
      Object.values(rates).some((v) => !Number.isFinite(v) || v < 0) ||
      rates.output <= 0 ||
      !Number.isInteger(maxOutput) ||
      maxOutput <= 0
    )
      throw new Error("Known positive model prices and output limit are required");
    const bytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
    if (bytes > 200_000) throw new Error("Delegated request exceeds context limit");
    // UTF-8 bytes plus serialization overhead intentionally overestimate text tokens.
    const inputRate = Math.max(rates.input, rates.cacheRead, rates.cacheWrite);
    const reserve =
      (((bytes * 2 + 1024) * inputRate + maxOutput * rates.output) * this.attempts) / 1_000_000;
    if (this.spent + reserve + (review ? 0 : this.reviewReserve) > this.limit) {
      this.exceeded = true;
      throw new Error("Delegation budget exhausted; review allowance preserved");
    }
    this.pending = reserve;
    this.calls += 1;
  }

  settle(usage: Usage, rates: Rates, failed: boolean): void {
    if (!this.pending) return; // An admission failure may itself emit an SDK error message.
    const tokens =
      (usage?.input ?? 0) +
      (usage?.output ?? 0) +
      (usage?.cacheRead ?? 0) +
      (usage?.cacheWrite ?? 0);
    if (failed || !Number.isFinite(tokens) || tokens <= 0) {
      this.unknown = true; // Never release money on transport failure or missing usage.
      return;
    }
    const actual = messageCostRub(usage, rates);
    if (!Number.isFinite(actual) || actual < 0) {
      this.unknown = true;
      return;
    }
    this.spent += actual;
    this.pending = 0;
    if (this.spent > this.limit) this.exceeded = true;
  }

  get chargedEstimate(): number {
    return this.spent + this.pending;
  }
}
