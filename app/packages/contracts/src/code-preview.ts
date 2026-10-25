/**
 * «Код» tab preview: a page the agent wrote, or a local server it started, shown in a
 * sandboxed side panel. Main serves only the workspace (loopback static server) and
 * http://127.0.0.1:<port>; nothing else may load in the frame.
 */
export type CodePreviewTarget =
  | { kind: "file"; path: string }
  | { kind: "server"; port: number };

export type CodePreviewResult =
  | { ok: true; url: string }
  | { ok: false; reason: "outside_workspace" | "missing" | "not_html" | "bad_port" | "down" };

export interface CodePreviewApi {
  /** Resolve a target to the URL the preview frame may load. */
  open(target: CodePreviewTarget, workspacePath: string | undefined): Promise<CodePreviewResult>;
  /** «Открыть в браузере»: the file in the default app, or the server URL in the browser. */
  openExternal(target: CodePreviewTarget, workspacePath: string | undefined): Promise<boolean>;
}
