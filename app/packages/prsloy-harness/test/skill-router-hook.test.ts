import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";
import { configureLearning, onLearningEvent } from "../src/learning-log.ts";
import { resolveOptions } from "../src/options.ts";
import { installSkillRouter } from "../src/skill-router-hook.ts";
import { readFlags } from "../src/flags.ts";
import { MockPi } from "./mock-pi.ts";

const root = mkdtempSync(join(tmpdir(), "skill-router-hook-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
configureLearning({ enabled: true, dir: join(root, "learning") });

describe("skill router hook", () => {
  it("keeps the router flag off by default and reads it from settings", () => {
    const settingsPath = join(root, "default-flags.json");
    expect(readFlags(undefined).skillRouter).toBe(false);
    writeFileSync(settingsPath, JSON.stringify({ skillRouter: true }));
    expect(readFlags(settingsPath).skillRouter).toBe(true);
  });

  it("requires both flags, injects only the confident skill and displays a card", async () => {
    const settingsPath = join(root, "flags.json");
    writeFileSync(settingsPath, JSON.stringify({ skills: true, skillRouter: true }));
    const pi = new MockPi(root);
    const modelRegistry = {
      find: (provider: string, id: string) => ({ provider, id }),
      complete: async () => ({
        content: [{ type: "text", text: '{"skill":"fix-code","confidence":0.91}' }],
        stopReason: "stop",
      }),
    };
    pi.ctx.modelRegistry = modelRegistry as never;
    installSkillRouter(pi.api, resolveOptions({ profile: "code", settingsPath }));
    const [handler] = pi.handlers.get("before_agent_start")!;
    const event: {
      messageType: string;
      prompt: string;
      systemPromptOptions: { sections: Record<string, string>; skills: { name: string }[] };
    } = {
      messageType: "user",
      prompt: "Fix the bug",
      systemPromptOptions: {
        sections: {},
        skills: [{ name: "site-landing" }, { name: "fix-code" }, { name: "excel-csv" }],
      },
    };
    await handler!(event, pi.ctx);
    // the other skills are hidden: the model has nothing to confuse it with
    expect(event.systemPromptOptions.skills).toEqual([{ name: "fix-code" }]);
    expect(event.systemPromptOptions.sections.prsloy_skill).toContain("# Починить чужой код");
    expect(Object.keys(event.systemPromptOptions.sections)).toEqual(["prsloy_skill"]);
    expect(pi.sent[0]?.content).toBe("Взял навык: починку кода");

    // the next message of the same chat: the same choice, no second router call and no second card
    let calls = 0;
    modelRegistry.complete = async () => {
      calls += 1;
      return {
        content: [{ type: "text", text: '{"skill":"excel-csv","confidence":0.99}' }],
        stopReason: "stop",
      };
    };
    const next: typeof event = {
      messageType: "user",
      prompt: "and the totals too",
      systemPromptOptions: { sections: {}, skills: [{ name: "fix-code" }, { name: "excel-csv" }] },
    };
    await handler!(next, pi.ctx);
    expect(calls).toBe(0);
    expect(next.systemPromptOptions.skills).toEqual([{ name: "fix-code" }]);
    expect(pi.sent).toHaveLength(1);

    writeFileSync(settingsPath, JSON.stringify({ skills: false, skillRouter: true }));
    const ignored: {
      messageType: string;
      prompt: string;
      systemPromptOptions: { sections: Record<string, string> };
    } = {
      messageType: "user",
      prompt: "Fix it",
      systemPromptOptions: { sections: {} },
    };
    await handler!(ignored, pi.ctx);
    expect(ignored.systemPromptOptions.sections).toEqual({});
  });

  it("records none and injects no skill below the confidence threshold", async () => {
    const settingsPath = join(root, "low-flags.json");
    writeFileSync(settingsPath, JSON.stringify({ skills: true, skillRouter: true }));
    const pi = new MockPi(root);
    pi.ctx.modelRegistry = {
      find: (provider: string, id: string) => ({ provider, id }),
      complete: async () => ({
        content: [{ type: "text", text: '{"skill":"fix-code","confidence":0.69}' }],
        stopReason: "stop",
      }),
    } as never;
    installSkillRouter(pi.api, resolveOptions({ profile: "code", settingsPath }));
    const events: string[] = [];
    const off = onLearningEvent((_session, event) => {
      if (event.kind === "skill.routed") events.push(event.sig ?? "");
    });
    const [handler] = pi.handlers.get("before_agent_start")!;
    const event: {
      messageType: string;
      prompt: string;
      systemPromptOptions: { sections: Record<string, string>; skills: { name: string }[] };
    } = {
      messageType: "user",
      prompt: "Maybe",
      systemPromptOptions: { sections: {}, skills: [{ name: "fix-code" }, { name: "excel-csv" }] },
    };
    await handler!(event, pi.ctx);
    off();
    expect(events).toEqual(["skill:none"]);
    expect(event.systemPromptOptions.sections).toEqual({});
    // not sure — no skills at all this turn
    expect(event.systemPromptOptions.skills).toEqual([]);
    expect(pi.sent).toEqual([]);
  });
});
