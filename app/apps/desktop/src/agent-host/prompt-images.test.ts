/**
 * #75: a screenshot attached in the composer has to reach the model.
 *
 * Two chains share one gate — pi's model `input` in models.json:
 * - the attachment (`loadPromptImages` → `session.prompt(…, { images })`);
 * - the read tool on a picture file.
 *
 * With "image" declared the picture travels as an `image_url` part; without it pi swaps the
 * picture for «(image omitted: model does not support images)». These tests pin both, so a
 * silent loss on our side cannot come back unnoticed.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { createPixRuntime, type ZenoRuntimeHandle } from "@zeno/agent-runtime";
import { FakeOpenAiServer } from "../../../../packages/test-utils/src/index.ts";
import { loadPromptImages, PROMPT_IMAGE_MIME_TYPES } from "./prompt-images.ts";

/** 64×64 red PNG: a picture with known content, small enough to compare byte for byte. */
const RED_PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAZUlEQVR4nO3PQQ3AIADAQEAISvCvAjETweOypKegnXef8WdLB7xqQGtAa0BrQGtAa0BrQGtAa0BrQGtAa0BrQGtAa0BrQGtAa0BrQGtAa0BrQGtAa0BrQGtAa0BrQGtAa0BrQPsAsA4BtodIlugAAAAASUVORK5CYII=";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function session(input: readonly string[]) {
  const root = tempDir("prompt-images-");
  const agentDir = join(root, "agent");
  const project = join(root, "project");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(project, { recursive: true });
  const picture = join(project, "shot.png");
  writeFileSync(picture, Buffer.from(RED_PIXEL_PNG, "base64"));
  const server = new FakeOpenAiServer({ toolPath: picture });
  await server.start();
  cleanups.push(() => server.stop());
  writeFileSync(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        "zeno-fake": {
          baseUrl: server.baseUrl,
          apiKey: "test-key-not-secret",
          api: "openai-completions",
          models: [
            {
              id: "zeno-fake",
              name: "Fake",
              reasoning: false,
              input: [...input],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 8192,
              maxTokens: 1024,
            },
          ],
        },
      },
    }),
  );
  const handle: ZenoRuntimeHandle = await createPixRuntime({
    cwd: project,
    agentDir,
    model: { provider: "zeno-fake", id: "zeno-fake" },
    tools: [],
    persistSession: false,
  });
  cleanups.push(() => handle.dispose());
  return { handle, server, picture };
}

describe("prompt images", () => {
  it("reads the formats pi takes, as base64 with the right mime type", async () => {
    const dir = tempDir("prompt-images-files-");
    const expected: Record<string, string> = {
      "a.png": "image/png",
      "b.jpg": "image/jpeg",
      "c.JPEG": "image/jpeg",
      "d.gif": "image/gif",
      "e.webp": "image/webp",
    };
    for (const name of Object.keys(expected)) {
      writeFileSync(join(dir, name), Buffer.from(RED_PIXEL_PNG, "base64"));
    }
    const images = await loadPromptImages(Object.keys(expected).map((name) => join(dir, name)));
    expect(images.map((image) => image.mimeType)).toEqual(Object.values(expected));
    expect(images.every((image) => image.type === "image")).toBe(true);
    expect(images[0]?.data).toBe(RED_PIXEL_PNG);
    expect(Object.keys(PROMPT_IMAGE_MIME_TYPES).sort()).toEqual(
      [".gif", ".jpeg", ".jpg", ".png", ".webp"].sort(),
    );
  });

  it("refuses what it cannot send instead of dropping it quietly", async () => {
    const dir = tempDir("prompt-images-bad-");
    const empty = join(dir, "empty.png");
    writeFileSync(empty, "");
    const svg = join(dir, "logo.svg");
    writeFileSync(svg, "<svg xmlns='http://www.w3.org/2000/svg'/>");
    await expect(loadPromptImages([empty])).rejects.toThrow(/empty/u);
    await expect(loadPromptImages([svg])).rejects.toThrow(/Unsupported prompt image type/u);
  });

  it("sends an attached picture to a model that declares image input", async () => {
    const { handle, server, picture } = await session(["text", "image"]);
    const images = await loadPromptImages([picture]);
    await handle.runtime.session.prompt("Что на картинке?", { images });
    const body = JSON.stringify(server.requests.at(-1));
    expect(body).toContain(RED_PIXEL_PNG.slice(0, 64));
    expect(body).toContain("image_url");
    expect(body).not.toContain("image omitted");
  });

  it("marks a text-only model's picture as omitted — the #75 symptom, now visible", async () => {
    const { handle, server, picture } = await session(["text"]);
    const images = await loadPromptImages([picture]);
    await handle.runtime.session.prompt("Что на картинке?", { images });
    const body = JSON.stringify(server.requests.at(-1));
    expect(body).not.toContain(RED_PIXEL_PNG.slice(0, 64));
    expect(body).toContain("image omitted: model does not support images");
  });
});
