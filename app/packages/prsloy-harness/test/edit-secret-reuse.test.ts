import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { EDIT_RETRY_NOTE, installEditRobustness, preserveFormat } from "../src/edit-robustness.ts";
import { resolveOptions } from "../src/options.ts";
import { installReusePrompt, REUSE_SECTION } from "../src/reuse-prompt.ts";
import { installSecretScrub, scrubSecrets } from "../src/secret-scrub.ts";
import { MockPi } from "./mock-pi.ts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("edit robustness", () => {
  async function setup() {
    const dir = await mkdtemp(join(tmpdir(), "prsloy-edit-"));
    dirs.push(dir);
    const pi = new MockPi(dir);
    installEditRobustness(pi.api, resolveOptions());
    return { pi, dir };
  }

  it("after two failed edits of the same file tells the model to re-read or rewrite it", async () => {
    const { pi } = await setup();
    const fail = (path: string) =>
      pi.toolResult({
        toolName: "edit",
        input: { path },
        text: `Could not find the exact text in ${path}.`,
        isError: true,
      });
    expect((await fail("a.ts")).text).not.toContain(EDIT_RETRY_NOTE);
    expect((await fail("b.ts")).text).not.toContain(EDIT_RETRY_NOTE);
    expect((await fail("./a.ts")).text).toContain(EDIT_RETRY_NOTE);
    await pi.toolResult({ toolName: "edit", input: { path: "a.ts" }, text: "ok" });
    expect((await fail("a.ts")).text).not.toContain(EDIT_RETRY_NOTE);
  });

  it("write over an existing CRLF + BOM file keeps CRLF and BOM", async () => {
    const { pi, dir } = await setup();
    await writeFile(join(dir, "win.txt"), "﻿one\r\ntwo\r\n");
    const input: Record<string, unknown> = { path: "win.txt", content: "one\ntwo\nthree\n" };
    await pi.toolCall("write", input);
    expect(input.content).toBe("﻿one\r\ntwo\r\nthree\r\n");
    const fresh: Record<string, unknown> = { path: "new.txt", content: "a\nb\n" };
    await pi.toolCall("write", fresh);
    expect(fresh.content).toBe("a\nb\n");
  });

  it("preserveFormat leaves LF files and already-CRLF content alone", () => {
    expect(preserveFormat("a\nb\n", "c\nd\n")).toBe("c\nd\n");
    expect(preserveFormat("a\r\nb\r\n", "c\r\nd\r\n")).toBe("c\r\nd\r\n");
    expect(preserveFormat("single line", "x\ny")).toBe("x\ny");
  });
});

describe("secret scrub", () => {
  const samples = {
    openai: "sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
    github: `ghp_${"a1B2".repeat(9)}`,
    aws: "AKIAIOSFODNN7EXAMPLE",
    awsSecret: "aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    pem: "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----",
  };

  it("redacts obvious keys", () => {
    for (const value of Object.values(samples)) {
      const out = scrubSecrets(`before ${value} after`);
      expect(out.count).toBe(1);
      expect(out.text).toContain("[СКРЫТО:");
      expect(out.text).toMatch(/^before .*after$/s);
    }
    expect(scrubSecrets(samples.awsSecret).text).toBe(
      "aws_secret_access_key = [СКРЫТО: AWS-секрет]",
    );
  });

  it("does not touch ordinary text", () => {
    const text =
      "sk-learn is a library; task-1234; AKIA; git sha 4f9c2e1d8b7a6f5e4d3c2b1a0f9e8d7c6b5a4f3e";
    expect(scrubSecrets(text)).toEqual({ text, count: 0, kinds: [] });
  });

  it("scrubs tool results and structuredContent before the model sees them, with a note", async () => {
    const pi = new MockPi();
    installSecretScrub(pi.api);
    const result = await pi.toolResult({
      toolName: "bash",
      text: `OPENAI_API_KEY=${samples.openai}`,
      structuredContent: { output: `OPENAI_API_KEY=${samples.openai}`, exit_code: 0 },
    });
    expect(result.text).not.toContain(samples.openai);
    expect(result.text).toContain("[Скрыто секретов: 1 (sk-ключ)");
    expect(JSON.stringify(result.structuredContent)).not.toContain(samples.openai);
    expect((result.structuredContent as { exit_code: number }).exit_code).toBe(0);
    expect((await pi.toolResult({ toolName: "read", text: "nothing secret" })).modified).toBe(
      false,
    );
  });
});

describe("reuse prompt", () => {
  async function sections(profile: "code" | "design") {
    const pi = new MockPi();
    installReusePrompt(pi.api, resolveOptions({ profile }));
    const event = {
      messageType: "user",
      prompt: "x",
      systemPrompt: "",
      systemPromptOptions: { sections: {} as Record<string, string> },
    };
    for (const handler of pi.handlers.get("before_agent_start") ?? [])
      await handler({ type: "before_agent_start", ...event }, pi.ctx);
    return event.systemPromptOptions.sections;
  }

  it("adds the E3 prior-art rule only in the «Код» profile", async () => {
    expect((await sections("code")).prsloy_reuse_first).toBe(REUSE_SECTION);
    expect(REUSE_SECTION).toContain(
      "check whether a well-established library or standard module already solves the problem",
    );
    expect(await sections("design")).toEqual({});
  });
});
