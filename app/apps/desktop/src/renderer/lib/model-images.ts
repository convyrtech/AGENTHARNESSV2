/**
 * Pictures and the chosen model (#75).
 *
 * pi sends a prompt picture to the gateway only when the model's `input` (models.json) lists
 * "image". For a text-only model it puts «(image omitted: model does not support images)» into
 * the message instead — the screenshot is gone and nobody says a word. So the composer has to
 * say it before the send and offer a model that does take pictures.
 *
 * The same gate rules the read tool: a text-only model reading a .png gets
 * «Current model does not support images» instead of the picture. One gate, one warning.
 */
import { isPromptImagePath } from "./composer-suggestions.ts";

export interface ModelCapability {
  provider: string;
  id: string;
  name: string;
  /** pi model `input`; absent means the host said nothing — treat as text-only. */
  input?: readonly string[] | undefined;
}
/** Anything the picker or the host hands us about a model; only `input` decides pictures. */
export type MaybeModel = {
  provider?: string | undefined;
  id?: string | undefined;
  name?: string | undefined;
  input?: readonly string[] | undefined;
};

/** Does this model take pictures? Only an explicit "image" counts. */
export function modelTakesImages(model: MaybeModel | undefined): boolean {
  return Boolean(model?.input?.includes("image"));
}

/** Attachments that will be sent as pictures (the rest go as file paths). */
export function attachedImagePaths(paths: readonly string[]): string[] {
  return paths.filter(isPromptImagePath);
}

/**
 * Models that can take a picture, in the order the picker shows them. The first one is the
 * offer the warning makes.
 */
export function imageCapableModels(models: readonly ModelCapability[]): ModelCapability[] {
  return models.filter((model) => modelTakesImages(model));
}

export interface ImageWarning {
  /** The chosen model, by the name the picker shows. */
  modelName: string;
  /** How many attached pictures would be lost. */
  images: number;
  /** A model that takes pictures, when the picker has one. */
  switchTo?: ModelCapability | undefined;
}

/**
 * What to warn about, or undefined when nothing is at risk: pictures attached to a model that
 * cannot take them. Text attachments never warn — their path reaches the model either way.
 */
export function imageWarning(options: {
  /** `provider/id` as the composer holds it, or the resolved model. */
  model: ModelCapability | undefined;
  attachments: readonly string[];
  models: readonly ModelCapability[];
}): ImageWarning | undefined {
  const images = attachedImagePaths(options.attachments).length;
  if (images === 0) return undefined;
  if (modelTakesImages(options.model)) return undefined;
  const switchTo = imageCapableModels(options.models).find(
    (model) => model.provider !== options.model?.provider || model.id !== options.model?.id,
  );
  return {
    modelName: options.model?.name || options.model?.id || "",
    images,
    switchTo,
  };
}

/** The model the composer's `provider/id` string points at. */
export function findModel(
  models: readonly ModelCapability[],
  value: string,
): ModelCapability | undefined {
  const at = value.indexOf("/");
  if (at <= 0) return undefined;
  const provider = value.slice(0, at);
  const id = value.slice(at + 1);
  return models.find((model) => model.provider === provider && model.id === id);
}
