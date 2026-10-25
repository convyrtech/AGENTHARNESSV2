/**
 * «Код»'s harness opens the user's pages in a browser with the «Дизайн» tools' python
 * (PRSLOY_DESIGN_PYTHON in the Agent Host env): only once that venv is installed.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { bootstrapPrsloy } from "../prsloy/context.ts";
import { venvPython } from "./env.ts";
import { DesignService } from "./service.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0).reverse()) fn();
});
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function service(root: string): DesignService {
  return new DesignService({
    userDataPath: join(root, "ud"),
    bundleRoot: join(root, "no-bundle"),
    fallbackRoot: join(root, "docs"),
    getWindow: () => undefined,
    getGateway: () => undefined,
    basePython: () => "python3",
    nodeExecutable: () => "node",
    piCliPath: async () => undefined,
    assertTrustedSender: () => undefined,
  });
}

describe("PRSLOY_DESIGN_PYTHON for the «Код» host", () => {
  it("no venv → no variable; tools installed → the venv's python", () => {
    const root = tempDir("prsloy-dpy-");
    const before = process.env.PRSLOY_DESIGN_VENV;
    cleanups.push(() => {
      if (before === undefined) delete process.env.PRSLOY_DESIGN_VENV;
      else process.env.PRSLOY_DESIGN_VENV = before;
    });
    const venv = join(root, "venv");
    process.env.PRSLOY_DESIGN_VENV = venv;
    const design = service(root);
    const ctx = bootstrapPrsloy({
      userDataPath: join(root, "ud"),
      cipher: {
        isEncryptionAvailable: () => true,
        encryptString: (t) => Buffer.from(t),
        decryptString: (b) => b.toString(),
      },
      env: {},
      platform: "linux",
    });
    ctx.designPython = () => design.designPython();
    // A stale value inherited from the user's env never leaks through.
    const base = { PATH: "/usr/bin", PRSLOY_DESIGN_PYTHON: "/somewhere/python" };
    expect(design.designPython()).toBeUndefined();
    expect(ctx.hostEnv(base).PRSLOY_DESIGN_PYTHON).toBeUndefined();

    mkdirSync(join(venvPython(venv), ".."), { recursive: true });
    writeFileSync(venvPython(venv), "");
    expect(design.designPython()).toBe(venvPython(venv));
    expect(ctx.hostEnv(base).PRSLOY_DESIGN_PYTHON).toBe(venvPython(venv));
    expect(venvPython("C:\\v", "win32").replaceAll("\\", "/")).toMatch(/Scripts\/python\.exe$/u);
  });
});
