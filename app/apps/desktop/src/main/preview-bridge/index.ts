/**
 * The script the «Код» preview server adds to every HTML page it serves on loopback. Only
 * that server injects it: the «Дизайн» preview and agent-started servers stay untouched.
 */
import inspector from "./inspector.js?raw";

export const PREVIEW_BRIDGE_SCRIPT = inspector;
