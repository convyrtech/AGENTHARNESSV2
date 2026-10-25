/**
 * Messages of the features taken from open-source analogs (research 19 §1), en.
 */
import type { featuresZh } from "./features.zh.ts";

export const featuresEn: Record<keyof typeof featuresZh, string> = {
  "features.pick.start": "Pick on the page",
  "features.pick.cancel": "Cancel picking",
  "features.pick.hint": "Click the place on the page to change. Esc cancels.",
  "features.pick.picked": "Picked: {what}. Write below what to change.",
  "features.pick.block.title": "Place on page {page}",
  "features.pick.block.element": "Element",
  "features.pick.block.text": "Text",
  "features.pick.block.code": "Code",
  "features.errors.one": "The page has an error",
  "features.errors.many": "Errors on the page: {count}",
  "features.errors.fix": "Fix",
  "features.errors.hide": "Hide",
  "features.errors.prompt": "Fix the errors on page {page}. The browser shows:",
  "features.errors.missing": "file didn't load: {file}",
  "features.pick.block.ask": "What to change here:",
};
