import { describe, expect, it } from "vite-plus/test";
import {
  failureAction,
  failureActionLabelKey,
  failureHintKey,
  failureKind,
  withoutRetryNoise,
} from "./model-failure.ts";

describe("failureKind", () => {
  it("follows the host's code", () => {
    expect(failureKind("no_balance", "402 Insufficient balance")).toBe("balance");
    expect(failureKind("auth", "401 Invalid API key")).toBe("key");
    expect(failureKind("network", "Связь с моделью оборвалась")).toBe("network");
    expect(failureKind("rate_limit", "429")).toBe("busy");
    expect(failureKind("timeout", "timed out")).toBe("slow");
    // A chat reopened from disk: only the proxy's text is left.
    expect(failureKind(undefined, "Модель долго не отвечает: нет ответа после 3 попыток")).toBe(
      "slow",
    );
    expect(failureKind("server", "500")).toBe("server");
  });

  it("a proxy that gave up after lost connections is a drop, whatever the 502 says", () => {
    const text =
      '502: {"message":"prsloy proxy: all 3 attempts failed","attempts":[{"n":1,"err":"TypeError: fetch failed"}]}';
    expect(failureKind("server", text)).toBe("network");
    expect(failureKind("server", "502 Bad Gateway")).toBe("server");
  });

  it("a missing model: the host's code, or the text of a reopened chat", () => {
    expect(failureKind("model_unavailable", "404 Not Found")).toBe("model");
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
    expect(failureActionLabelKey("crash")).toBe("failure.action.retryLast");
    expect(failureActionLabelKey("network")).toBe("system.retry.action");
    expect(failureActionLabelKey("balance")).toBe("failure.action.topUp");
    expect(failureHintKey("network")).toBeUndefined();
    expect(failureHintKey("model")).toBe("failure.model.hint");
    // A silent model: [Повторить] and «…или переключитесь на «Быстрее»».
    expect(failureHintKey("slow")).toBe("failure.slow.hint");
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

  it("drops the host's «restarted» note (the crash card says it)", () => {
    const restarted = { kind: "system", text: "Agent Host restarted", tone: "info" };
    expect(withoutRetryNoise([user, restarted, reply])).toEqual([user, reply]);
  });

  it("leaves other turns alone", () => {
    expect(withoutRetryNoise([user, fail, user, reply])).toEqual([user, fail, user, reply]);
  });
});
