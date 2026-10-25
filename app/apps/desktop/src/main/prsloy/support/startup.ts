/**
 * Side-effect module, imported right after user-data-electron (userData is final by then):
 * - crash dumps stay local (Crashpad under userData, never uploaded);
 * - the console also goes to userData/logs/main.log (for the support report);
 * - a renderer or child process (the Agent Host is a utilityProcess) that dies is logged
 *   with its reason.
 */
import { app, crashReporter } from "electron";
import { join } from "node:path";
import { installLogFile } from "./log-file.ts";

crashReporter.start({ uploadToServer: false, compress: true });

export const SUPPORT_LOG_DIR = join(app.getPath("userData"), "logs");
installLogFile({ dir: SUPPORT_LOG_DIR });

app.on("render-process-gone", (_event, _contents, details) => {
  console.error(`[prsloy] renderer gone: ${details.reason} (exit code ${details.exitCode})`);
});
app.on("child-process-gone", (_event, details) => {
  const name = details.name ? ` «${details.name}»` : "";
  console.error(
    `[prsloy] ${details.type} process${name} gone: ${details.reason} (exit code ${details.exitCode})`,
  );
});
