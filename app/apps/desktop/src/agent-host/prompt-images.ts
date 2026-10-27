/**
 * Attachments → pi prompt images (#75).
 *
 * The composer sends picture paths; this turns them into the `{ type: "image", data, mimeType }`
 * blocks pi puts into the user message. What happens next is pi's call: for a model whose
 * `input` has no "image" (models.json) pi replaces the picture with
 * «(image omitted: model does not support images)» — so a picture reaches the gateway only
 * when the model is declared image-capable there. That is why the composer warns before the
 * send when the chosen model cannot take pictures (renderer/lib/model-images.ts).
 */
import { readFile } from "node:fs/promises";
import { extname } from "node:path";

/** Formats pi accepts as prompt images (`PROMPT_IMAGE_MIME_TYPES` mirrors the read tool). */
export const PROMPT_IMAGE_MIME_TYPES: Readonly<Record<string, string>> = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

export type PromptImage = { type: "image"; data: string; mimeType: string };

/** An unsupported file type or an empty file is a real error: the model would get nothing. */
export async function loadPromptImages(paths: readonly string[]): Promise<PromptImage[]> {
  return Promise.all(
    paths.map(async (path) => {
      const mimeType = PROMPT_IMAGE_MIME_TYPES[extname(path).toLowerCase()];
      if (!mimeType) throw new Error(`Unsupported prompt image type: ${path}`);
      const bytes = await readFile(path);
      if (bytes.byteLength === 0) throw new Error(`Prompt image is empty: ${path}`);
      return { type: "image" as const, data: bytes.toString("base64"), mimeType };
    }),
  );
}
