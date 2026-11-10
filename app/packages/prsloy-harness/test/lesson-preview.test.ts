import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vite-plus/test";
import { collectPreviewSignals, previewPrompt, validatePreview } from "../src/lesson-preview.ts";

const context = {
  surface: "code",
  project: "1234567890abcdef",
  session: "private-session",
  scope: "1234567890abcdef1234567890abcdef",
};
const modelRef = { ...context, kind: "delegate.model_ref", sig: "unavailable-openai-model" };
const noChanges = { ...context, kind: "delegate.no_changes", sig: "worker-no-file-change" };
const verified = { ...context, kind: "delegate.verified", sig: "check-review" };
const turnEnd = { ...context, kind: "turn.end", outcome: "green" };
const jsonl = (...rows: object[]) => rows.map((row) => JSON.stringify(row)).join("\n");
const cli = fileURLToPath(new URL("../scripts/reflect-lessons.mts", import.meta.url));

describe("lesson draft preview", () => {
  it("requires a verified delegation in the same project, session and turn", () => {
    expect(
      collectPreviewSignals(
        jsonl(
          modelRef,
          { ...verified, project: "0123456789abcdef" },
          { ...verified, session: "other" },
          { ...verified, scope: "aaaabbbbccccddddaaaabbbbccccdddd" },
          turnEnd,
          verified,
          noChanges,
          noChanges,
          verified,
          verified,
          turnEnd,
        ),
      ),
    ).toEqual([
      { id: "delegate.model_ref", failures: 1, recoveries: 0 },
      { id: "delegate.no_changes", failures: 2, recoveries: 1 },
    ]);
  });

  it("sends fixed signals and counts without arbitrary event fields", () => {
    const prompt = previewPrompt(
      collectPreviewSignals(
        jsonl(
          { ...modelRef, sig: "unrecognized-private-sig" },
          {
            ...modelRef,
            raw: "secret user request",
            model: "custom-private-model",
            path: "/home/private",
          },
          verified,
        ),
      ),
    );
    expect(prompt).toContain('"recoveries":1');
    for (const value of [
      context.project,
      context.session,
      context.scope,
      "unrecognized-private-sig",
      "secret user request",
      "custom-private-model",
      "/home/private",
    ])
      expect(prompt).not.toContain(value);
  });

  it("validates one strict decision per recovered signal", () => {
    const candidates = collectPreviewSignals(jsonl(modelRef, noChanges, verified));
    const draft = {
      id: modelRef.kind,
      decision: "draft",
      cause: "Unknown model",
      lesson: "Use the configured provider/model pair.",
    };
    const none = { id: noChanges.kind, decision: "none", cause: "Insufficient evidence" };
    expect(validatePreview(JSON.stringify([draft, none]), candidates)).toEqual([draft, none]);
    for (const invalid of [
      [draft, draft],
      [draft],
      [{ ...draft, extra: true }, none],
      [draft, { ...none, lesson: "x" }],
      [{ ...draft, cause: "   " }, none],
      [{ ...draft, lesson: "X".repeat(221) }, none],
    ])
      expect(validatePreview(JSON.stringify(invalid), candidates)).toBeUndefined();
    const markdown = ["```json", JSON.stringify([draft, none]), "```"].join("\n");
    expect(validatePreview(markdown, candidates)).toBeUndefined();
    expect(
      validatePreview(JSON.stringify([draft]), collectPreviewSignals(jsonl(modelRef, turnEnd))),
    ).toBeUndefined();
  });

  it("makes one bounded call only with verified evidence and leaves the preview directory untouched", async () => {
    const dir = await mkdtemp(join(tmpdir(), "prsloy-preview-test-"));
    const calls: unknown[] = [];
    const model = "minimax-m3.1-flash";
    const decision = {
      id: noChanges.kind,
      decision: "draft",
      cause: "No patch",
      lesson: "Ask for an explicit file edit.",
    };
    const server = createServer(async (req, res) => {
      const body = [];
      for await (const chunk of req) body.push(Buffer.from(chunk));
      calls.push({ url: req.url, ...JSON.parse(Buffer.concat(body).toString()) });
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          model,
          choices: [{ finish_reason: "stop", message: { content: JSON.stringify([decision]) } }],
        }),
      );
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected an IPv4 listener");
      const events = join(dir, "events.jsonl");
      const preview = async () =>
        JSON.parse(
          (
            await promisify(execFile)(
              process.execPath,
              [
                cli,
                "--preview-drafts",
                "--events",
                events,
                "--base-url",
                `http://127.0.0.1:${address.port}/v1`,
              ],
              {
                cwd: dir,
                env: { ...process.env, PRSLOY_GATEWAY_KEY: "unit-test-loopback" },
                timeout: 5000,
              },
            )
          ).stdout,
        );

      await writeFile(events, jsonl(noChanges, turnEnd));
      expect(await preview()).toMatchObject({ requested: false, drafts: [] });
      expect(calls).toHaveLength(0);
      await writeFile(events, jsonl(noChanges, verified, turnEnd));
      expect(await preview()).toMatchObject({
        model,
        requested: true,
        valid: true,
        drafts: [decision],
      });
      expect(calls).toEqual([
        expect.objectContaining({ url: "/v1/chat/completions", model, max_tokens: 768 }),
      ]);
      expect(await readdir(dir)).toEqual(["events.jsonl"]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    }
  });
});
