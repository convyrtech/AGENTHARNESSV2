// Node-Playwright для тестов проверки страницы: из пакета или из devDependencies приложения; нет — undefined.
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import type { NodePlaywright } from "../src/page-check.ts";

export const CHROMIUM = existsSync("/opt/pw-browsers/chromium")
  ? "/opt/pw-browsers/chromium"
  : undefined;

/** Playwright и запускается ли его Chromium (своя сборка или /opt/pw-browsers). */
export async function loadPlaywright(): Promise<NodePlaywright | undefined> {
  let pw: NodePlaywright | undefined;
  for (const load of [
    () => import("playwright" as string),
    () =>
      createRequire(new URL("../../../apps/desktop/package.json", import.meta.url))("playwright"),
  ]) {
    try {
      pw = (await load()) as NodePlaywright;
      break;
    } catch {
      // следующий
    }
  }
  if (!pw) return undefined;
  try {
    const b = await pw.chromium.launch(CHROMIUM ? { executablePath: CHROMIUM } : {});
    await b.close();
    return pw;
  } catch {
    return undefined;
  }
}
