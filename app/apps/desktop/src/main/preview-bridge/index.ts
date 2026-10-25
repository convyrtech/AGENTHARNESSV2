/**
 * The script the «Код» preview server adds to every HTML page it serves on loopback. Only
 * that server injects it: the «Дизайн» preview and agent-started servers stay untouched.
 * Page errors go first: they must hear errors of the page's own first scripts.
 */
import inspector from "./inspector.js?raw";
import pageErrors from "./page-errors.js?raw";

export const PREVIEW_BRIDGE_SCRIPT = `${pageErrors}\n${inspector}`;
