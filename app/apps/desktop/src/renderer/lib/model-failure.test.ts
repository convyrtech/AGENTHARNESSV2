import { describe, expect, it } from "vite-plus/test";
import { failureAction, failureHintKey, failureKind, withoutRetryNoise } from "./model-failure.ts";

describe("failureKind", () => {
  it("follows the host's code", () => {
    expect(failureKind("no_balance", "402 Insufficient balance")).toBe("balance");
    expect(failureKind("auth", "401 Invalid API key")).toBe("key");
    expect(failureKind("network", "Связь с моделью оборвалась")).toBe("network");
    expect(failureKind("rate_limit", "429")).toBe("busy");
    expect(failureKind("timeout", "timed out")).toBe("slow");
    expect(failureKind("server", "500")).toBe("server");
  });

  it("reads a missing model from the text (no code for it yet)", () => {
    expect(failureKind("unknown", "404 The model `kimi-k9` does not exist")).toBe("model");
    expect(failureKind(undefined, '{"error":{"code":"model_not_found"}}')).toBe("model");
  });

  it("reads a reopened chat's raw text when there is no code", () => {
    expect(failureKind(undefined, "402 Insufficient balance")).toBe("balance");
    expect(failureKind(undefined, "401 Invalid API key")).toBe("key");
    expect(failureKind(undefined, "429 Too Many Requests")).toBe("busy");
    expect(failureKind(undefined, "503 Service Unavailable")).toBe("server");
    expect(failureKind(undefined, "terminated")).toBe("network");
    expect(failureKind(undefined, "Связь с моделью оборвалась")).toBe("network");
  });

  it("gives each kind one action and a hint only where needed", () => {
    expect(failureAction("balance")).toBe("topUp");
    expect(failureAction("key")).toBe("changeKey");
    for (const kind of ["network", "model", "busy", "slow", "server"] as const) {
      expect(failureAction(kind)).toBe("retry");
    }
    expect(failureHintKey("network")).toBeUndefined();
    expect(failureHintKey("model")).toBe("failure.model.hint");
  });
});

describe("withoutRetryNoise", () => {
  const user = { kind: "user", id: "u" };
  const fail = { kind: "system", title: "Response failed", tone: "error", id: "f" };
  const retry = (n: number) => ({ kind: "system", title: "Retry", tone: "info", attempt: n });
  const gaveUp = { kind: "system", title: "Retry", tone: "error", id: "g" };
  const reply = { kind: "assistant", id: "a" };

  it("keeps one «trying again» line while the retry runs", () => {
    expect(withoutRetryNoise([user, fail, retry(1)])).toEqual([user, retry(1)]);
  });

  it("drops the superseded failure and the retry lines once the retry worked", () => {
    expect(withoutRetryNoise([user, fail, retry(1), reply])).toEqual([user, reply]);
  });

  it("ends with a single failure card when every retry failed", () => {
    expect(withoutRetryNoise([user, fail, retry(1), fail, retry(2), fail, gaveUp])).toEqual([
      user,
      fail,
    ]);
  });

  it("leaves other turns alone", () => {
    expect(withoutRetryNoise([user, fail, user, reply])).toEqual([user, fail, user, reply]);
  });
});
