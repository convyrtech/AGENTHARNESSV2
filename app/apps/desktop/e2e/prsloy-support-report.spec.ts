import { existsSync, readdirSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { MockGatewayServer } from "@zeno/test-utils";
import { readZip } from "../src/main/prsloy/support/read-zip.ts";
import { expect, launchZenoApp, startHost, test } from "./fixtures.ts";

/**
 * PRSLOY stage 7: Settings → «Аккаунт» → «Сохранить отчёт для поддержки» writes a zip
 * (no network) and the saved key is nowhere inside it.
 */
test("support report: button → zip with versions and logs, no key inside", async () => {
  const key = `sk-prsloy-report-${Date.now()}-a1b2c3d4`;
  const gateway = new MockGatewayServer({ apiKey: key, modelIds: ["deepseek-v4.1-flash-1017"] });
  await gateway.start();
  const launched = await launchZenoApp();
  try {
    const { page, app } = launched;
    await startHost(page);
    const saved = await page.evaluate(([k, url]) => window.zeno.prsloy.setKey(k, url), [
      key,
      gateway.baseUrl,
    ] as const);
    expect(saved.ok).toBe(true);

    await page.getByTestId("nav-settings").click();
    await page.getByTestId("settings-nav-account").click();
    await page.getByTestId("settings-support-report").click();
    await expect(page.getByTestId("settings-support-result")).toContainText("PRSLOY-отчёт-", {
      timeout: 30_000,
    });

    const paths = await app.evaluate(({ app: a }) =>
      (["desktop", "downloads", "documents", "userData"] as const).map((n) => {
        try {
          return a.getPath(n);
        } catch {
          return "";
        }
      }),
    );
    const dirs = [...paths.slice(0, 3), join(paths[3]!, "reports")];
    const zipPath = dirs
      .filter((d) => d && existsSync(d))
      .flatMap((d) => readdirSync(d).map((n) => join(d, n)))
      .find((p) => /PRSLOY-отчёт-.*\.zip$/u.test(p));
    expect(zipPath, `report in ${dirs.join(", ")}`).toBeTruthy();
    const files = readZip(readFileSync(zipPath!));
    expect([...files.keys()]).toEqual(
      expect.arrayContaining(["report.json", "logs/main.log", "settings/prsloy-state.json"]),
    );
    const report = JSON.parse(files.get("report.json")!.toString("utf8"));
    expect(report.versions.app).toBeTruthy();
    expect(report.versions.electron).toBeTruthy();
    const all = Buffer.concat([...files.values()]);
    expect(all.includes(Buffer.from(key))).toBe(false);
    await rm(zipPath!, { force: true });
  } finally {
    await launched.app.close().catch(() => undefined);
    await launched.fakeModel.stop().catch(() => undefined);
    await gateway.stop().catch(() => undefined);
    await rm(launched.root, { recursive: true, force: true }).catch(() => undefined);
  }
});
