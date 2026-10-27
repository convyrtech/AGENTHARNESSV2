import { describe, expect, it } from "vite-plus/test";
import {
  attachedImagePaths,
  findModel,
  imageCapableModels,
  imageWarning,
  modelTakesImages,
} from "./model-images.ts";

const vision = { provider: "prsloy", id: "deepseek", name: "DeepSeek", input: ["text", "image"] };
const blind = { provider: "prsloy", id: "qwen", name: "Qwen", input: ["text"] };
const silent = { provider: "prsloy", id: "new-one", name: "new-one" };

describe("model capabilities for pictures (#75)", () => {
  it("only an explicit image input takes pictures", () => {
    expect(modelTakesImages(vision)).toBe(true);
    expect(modelTakesImages(blind)).toBe(false);
    // The host said nothing about a model the catalog does not know: pi drops the picture.
    expect(modelTakesImages(silent)).toBe(false);
    expect(modelTakesImages(undefined)).toBe(false);
  });

  it("counts only the attachments that travel as pictures", () => {
    expect(
      attachedImagePaths(["/tmp/a.png", "/tmp/b.PNG", "/tmp/c.jpg", "/tmp/d.webp"]),
    ).toHaveLength(4);
    expect(attachedImagePaths(["/tmp/notes.md", "/tmp/site.zip", "/tmp/logo.svg"])).toEqual([]);
  });

  it("warns when a picture is attached to a text-only model", () => {
    const warning = imageWarning({
      model: blind,
      attachments: ["/tmp/shot.png", "/tmp/notes.md"],
      models: [blind, vision],
    });
    expect(warning).toMatchObject({ modelName: "Qwen", images: 1 });
    expect(warning?.switchTo).toEqual(vision);
  });

  it("says nothing for a model that takes pictures, or for text attachments", () => {
    expect(
      imageWarning({ model: vision, attachments: ["/tmp/shot.png"], models: [blind, vision] }),
    ).toBeUndefined();
    expect(
      imageWarning({ model: blind, attachments: ["/tmp/notes.md"], models: [blind, vision] }),
    ).toBeUndefined();
    expect(imageWarning({ model: blind, attachments: [], models: [blind] })).toBeUndefined();
  });

  it("offers nothing to switch to when no served model takes pictures", () => {
    const warning = imageWarning({
      model: blind,
      attachments: ["/tmp/shot.png"],
      models: [blind, silent],
    });
    expect(warning?.switchTo).toBeUndefined();
    expect(imageCapableModels([blind, silent])).toEqual([]);
  });

  it("resolves the composer's provider/id string", () => {
    expect(findModel([blind, vision], "prsloy/deepseek")).toEqual(vision);
    expect(findModel([blind, vision], "prsloy/gone")).toBeUndefined();
    expect(findModel([blind], "")).toBeUndefined();
  });
});
