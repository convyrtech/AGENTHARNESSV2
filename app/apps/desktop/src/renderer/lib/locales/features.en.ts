/**
 * Messages of the features taken from open-source analogs (research 19 §1), en.
 */
import type { featuresZh } from "./features.zh.ts";

export const featuresEn: Record<keyof typeof featuresZh, string> = {
  "features.history.open": "Version history",
  "features.history.title": "Version history",
  "features.history.hint":
    "The project's files are saved before every request. Go back to how they were before any of them.",
  "features.history.empty": "No versions yet: they appear after the first request.",
  "features.history.loading": "Loading…",
  "features.history.beforeUndo": "Before an undo",
  "features.history.noText": "(no text)",
  "features.history.today": "today {time}",
  "features.history.yesterday": "yesterday {time}",
  "features.history.restore": "Restore",
  "features.history.confirmTitle": "Go back to this version?",
  "features.history.confirmMessage":
    "Files return to how they were before “{what}”. The current state is kept in the history, so you can come back.",
  "features.history.close": "Close",
  "features.zip.action": "Download archive",
  "features.zip.saved": "Archive saved: {name}",
  "features.zip.empty": "There are no files in the project to pack.",
  "features.zip.tooBig": "The project is over 200 MB, so it can't be packed.",
  "features.zip.failed": "Couldn't save the archive.",
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
