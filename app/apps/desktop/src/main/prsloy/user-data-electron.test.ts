import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mock = vi.hoisted(() => ({
  app: {
    isPackaged: false,
    commandLine: { hasSwitch: vi.fn() },
    getPath: vi.fn(),
    setPath: vi.fn(),
  },
  plan: vi.fn(),
  migrate: vi.fn(),
  remove: vi.fn(),
}));

vi.mock("electron", () => ({ app: mock.app }));
vi.mock("node:fs", () => ({ rmSync: mock.remove }));
vi.mock("./user-data.ts", () => ({
  prsloyUserDataDir: mock.plan,
  migrateLegacyUserData: mock.migrate,
}));

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  mock.app.isPackaged = false;
  mock.app.commandLine.hasSwitch.mockReturnValue(false);
  mock.app.getPath.mockReturnValue("fixture-app-data");
  mock.plan.mockReturnValue({ target: "fixture-target", legacy: "fixture-legacy" });
  mock.migrate.mockReturnValue({ status: "none" });
});

describe("profile setup before Electron startup", () => {
  it.each([
    { packaged: false, explicit: false },
    { packaged: true, explicit: true },
  ])(
    "skips appData lookup for $packaged packaged / $explicit explicit profile",
    async ({ packaged, explicit }) => {
      mock.app.isPackaged = packaged;
      mock.app.commandLine.hasSwitch.mockReturnValue(explicit);
      mock.app.getPath.mockImplementation(() => {
        throw new Error("Failed to get 'appData' path");
      });
      await expect(import("./user-data-electron.ts")).resolves.toBeDefined();
      expect(mock.app.getPath).not.toHaveBeenCalled();
      expect(mock.plan).not.toHaveBeenCalled();
      expect(mock.migrate).not.toHaveBeenCalled();
      expect(mock.app.setPath).not.toHaveBeenCalled();
      expect(mock.remove).not.toHaveBeenCalled();
    },
  );

  it("still plans and migrates the installed application's default profile", async () => {
    mock.app.isPackaged = true;
    await import("./user-data-electron.ts");
    expect(mock.app.getPath).toHaveBeenCalledExactlyOnceWith("appData");
    expect(mock.plan).toHaveBeenCalledExactlyOnceWith({
      appData: "fixture-app-data",
      packaged: true,
      explicitUserDataDir: false,
    });
    expect(mock.migrate).toHaveBeenCalledExactlyOnceWith({
      target: "fixture-target",
      legacy: "fixture-legacy",
    });
    expect(mock.app.setPath).toHaveBeenCalledExactlyOnceWith("userData", "fixture-target");
    expect(mock.remove).not.toHaveBeenCalled();
  });

  it("keeps the legacy-profile recovery when migration fails", async () => {
    mock.app.isPackaged = true;
    mock.migrate.mockReturnValue({ status: "failed", error: "fixture failure" });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await import("./user-data-electron.ts");
      expect(mock.remove).toHaveBeenCalledExactlyOnceWith("fixture-target", {
        recursive: true,
        force: true,
      });
      expect(mock.app.setPath).toHaveBeenCalledExactlyOnceWith("userData", "fixture-legacy");
    } finally {
      warning.mockRestore();
    }
  });
});
