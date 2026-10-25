import { describe, expect, it, vi } from "vite-plus/test";
import {
  buildAppUpdateStatus,
  createAutoUpdateController,
  DEFAULT_UPDATE_FEED,
  resolveUpdateFeed,
  updatesDisabledByEnv,
} from "./auto-update.ts";

describe("buildAppUpdateStatus", () => {
  it("includes optional fields only when provided", () => {
    expect(
      buildAppUpdateStatus({
        state: "idle",
        currentVersion: "0.4.0",
        canCheck: true,
      }),
    ).toEqual({
      state: "idle",
      currentVersion: "0.4.0",
      canCheck: true,
    });

    expect(
      buildAppUpdateStatus({
        state: "available",
        currentVersion: "0.4.0",
        canCheck: true,
        availableVersion: "0.5.0",
        percent: 10,
        error: "x",
        checkedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toEqual({
      state: "available",
      currentVersion: "0.4.0",
      canCheck: true,
      availableVersion: "0.5.0",
      percent: 10,
      error: "x",
      checkedAt: "2026-01-01T00:00:00.000Z",
    });
  });
});

describe("createAutoUpdateController", () => {
  it("skips network checks when not packaged", async () => {
    const broadcast = vi.fn();
    const loadUpdater = vi.fn(() => {
      throw new Error("should not load updater");
    });
    const controller = createAutoUpdateController({
      broadcast,
      isPackaged: false,
      getVersion: () => "0.4.0",
      loadUpdater,
      platform: "win32",
      startupDelayMs: 60_000,
    });

    expect(controller.getStatus()).toMatchObject({
      state: "idle",
      currentVersion: "0.4.0",
      canCheck: false,
    });

    const checked = await controller.checkForUpdates();
    expect(checked.state).toBe("not-available");
    expect(checked.canCheck).toBe(false);
    expect(loadUpdater).not.toHaveBeenCalled();
    expect(broadcast).toHaveBeenCalled();
    controller.dispose();
  });

  it("checks once via injected updater when packaged (Windows path)", async () => {
    const broadcast = vi.fn();
    const checkForUpdates = vi.fn(async () => ({
      updateInfo: { version: "0.5.0" },
    }));
    const downloadUpdate = vi.fn(async () => undefined);
    const quitAndInstall = vi.fn();
    const setFeedURL = vi.fn();
    const listeners = new Map<string, Array<(...args: unknown[]) => void>>();

    const updater = {
      autoDownload: true,
      autoInstallOnAppQuit: false,
      allowPrerelease: true,
      logger: null as typeof console | null,
      checkForUpdates,
      downloadUpdate,
      quitAndInstall,
      setFeedURL,
      on(event: string, listener: (...args: unknown[]) => void) {
        const list = listeners.get(event) ?? [];
        list.push(listener);
        listeners.set(event, list);
      },
      removeAllListeners() {
        listeners.clear();
      },
    };

    const controller = createAutoUpdateController({
      broadcast,
      isPackaged: true,
      getVersion: () => "0.4.0",
      loadUpdater: () => updater,
      platform: "win32",
      startupDelayMs: 60_000,
    });

    const available = await controller.checkForUpdates();
    expect(setFeedURL).toHaveBeenCalledWith(DEFAULT_UPDATE_FEED);
    expect(updater.autoDownload).toBe(false);
    expect(updater.autoInstallOnAppQuit).toBe(true);
    expect(checkForUpdates).toHaveBeenCalledTimes(1);
    expect(available.state).toBe("available");
    expect(available.availableVersion).toBe("0.5.0");

    // Simulate download events then await downloadUpdate
    const progressHandlers = listeners.get("download-progress") ?? [];
    const downloadedHandlers = listeners.get("update-downloaded") ?? [];
    const downloadPromise = controller.downloadUpdate();
    for (const handler of progressHandlers) handler({ percent: 42 });
    for (const handler of downloadedHandlers) handler({ version: "0.5.0" });
    const downloaded = await downloadPromise;
    expect(downloadUpdate).toHaveBeenCalledTimes(1);
    expect(downloaded.state).toBe("downloaded");

    controller.quitAndInstall();
    expect(controller.getStatus().state).toBe("installing");
    expect(quitAndInstall).toHaveBeenCalledWith(true, true);
    // Second click while installing is a no-op.
    controller.quitAndInstall();
    expect(quitAndInstall).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  it("installs mac updates without Squirrel.Mac", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "zeno-mac-update-test-"));
    const zipPath = join(dir, "Zeno-0.5.2-mac-arm64.zip");
    writeFileSync(zipPath, "zip");

    const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    const quitAndInstall = vi.fn();
    const installMacUpdate = vi.fn(async () => undefined);
    const relaunchApp = vi.fn();

    const updater = {
      autoDownload: true,
      autoInstallOnAppQuit: true,
      allowPrerelease: true,
      logger: null as typeof console | null,
      checkForUpdates: vi.fn(async () => ({ updateInfo: { version: "0.5.2" } })),
      downloadUpdate: vi.fn(async () => {
        for (const listener of listeners.get("update-downloaded") ?? []) {
          listener({ version: "0.5.2", downloadedFile: zipPath });
        }
      }),
      quitAndInstall,
      setFeedURL: vi.fn(),
      on(event: string, listener: (...args: unknown[]) => void) {
        const list = listeners.get(event) ?? [];
        list.push(listener);
        listeners.set(event, list);
      },
      removeAllListeners() {
        listeners.clear();
      },
    };

    try {
      const controller = createAutoUpdateController({
        broadcast: vi.fn(),
        isPackaged: true,
        getVersion: () => "0.5.0",
        loadUpdater: () => updater,
        platform: "darwin",
        installMacUpdate,
        relaunchApp,
        startupDelayMs: 60_000,
      });

      await controller.checkForUpdates();
      expect(updater.autoInstallOnAppQuit).toBe(false);

      const downloaded = await controller.downloadUpdate();
      expect(downloaded.state).toBe("downloaded");
      expect(downloaded.availableVersion).toBe("0.5.2");

      controller.quitAndInstall();
      expect(controller.getStatus().state).toBe("installing");
      // Async install path — wait until relaunch is scheduled.
      for (let i = 0; i < 20 && relaunchApp.mock.calls.length === 0; i += 1) {
        await Promise.resolve();
      }
      expect(installMacUpdate).toHaveBeenCalledWith(zipPath);
      expect(quitAndInstall).not.toHaveBeenCalled();
      expect(relaunchApp).toHaveBeenCalled();
      // Re-entrant install while in flight is ignored.
      controller.quitAndInstall();
      expect(installMacUpdate).toHaveBeenCalledTimes(1);
      controller.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("surfaces updater errors", async () => {
    const controller = createAutoUpdateController({
      broadcast: () => undefined,
      isPackaged: true,
      getVersion: () => "0.4.0",
      loadUpdater: () => ({
        autoDownload: false,
        autoInstallOnAppQuit: true,
        allowPrerelease: false,
        logger: null,
        checkForUpdates: async () => {
          throw new Error("network down");
        },
        downloadUpdate: async () => undefined,
        quitAndInstall: () => undefined,
        on() {
          // no-op
        },
        removeAllListeners() {
          // no-op
        },
      }),
      platform: "win32",
      startupDelayMs: 60_000,
    });

    const status = await controller.checkForUpdates();
    expect(status.state).toBe("error");
    expect(status.error).toContain("network down");
    controller.dispose();
  });

  it("PRSLOY feed: own repo, prereleases allowed, quiet download after the startup check", async () => {
    vi.useFakeTimers();
    try {
      const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
      const emit = (event: string, ...args: unknown[]) =>
        (listeners.get(event) ?? []).forEach((fn) => fn(...args));
      const broadcast = vi.fn();
      const updater = {
        autoDownload: true,
        autoInstallOnAppQuit: false,
        allowPrerelease: false,
        logger: null as typeof console | null,
        checkForUpdates: vi.fn(async () => {
          emit("update-available", { version: "0.1.0-alpha.3" });
          return { updateInfo: { version: "0.1.0-alpha.3" } };
        }),
        downloadUpdate: vi.fn(async () => {
          emit("update-downloaded", { version: "0.1.0-alpha.3" });
        }),
        quitAndInstall: vi.fn(),
        setFeedURL: vi.fn(),
        on(event: string, listener: (...args: unknown[]) => void) {
          listeners.set(event, [...(listeners.get(event) ?? []), listener]);
        },
        removeAllListeners() {
          listeners.clear();
        },
      };
      const controller = createAutoUpdateController({
        broadcast,
        isPackaged: true,
        getVersion: () => "0.1.0-alpha.2",
        loadUpdater: () => updater,
        platform: "win32",
        startupDelayMs: 10,
        disabled: false,
      });
      expect(DEFAULT_UPDATE_FEED).toMatchObject({ owner: "convyrtech", repo: "AGENTHARNESSV2" });
      await vi.advanceTimersByTimeAsync(20);
      expect(updater.allowPrerelease).toBe(true);
      expect(updater.setFeedURL).toHaveBeenCalledWith(DEFAULT_UPDATE_FEED);
      expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);
      expect(controller.getStatus()).toMatchObject({
        state: "downloaded",
        availableVersion: "0.1.0-alpha.3",
      });
      controller.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("never checks in test mode", async () => {
    vi.useFakeTimers();
    try {
      const loadUpdater = vi.fn();
      const controller = createAutoUpdateController({
        broadcast: () => undefined,
        isPackaged: true,
        getVersion: () => "0.1.0-alpha.2",
        loadUpdater,
        platform: "win32",
        startupDelayMs: 10,
        disabled: updatesDisabledByEnv({ ZENO_ENABLE_TEST_COMMANDS: "1" }),
      });
      await vi.advanceTimersByTimeAsync(50);
      expect((await controller.checkForUpdates()).state).toBe("not-available");
      expect(loadUpdater).not.toHaveBeenCalled();
      expect(updatesDisabledByEnv({ PRSLOY_NO_UPDATE: "1" })).toBe(true);
      expect(updatesDisabledByEnv({})).toBe(false);
      controller.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("resolveUpdateFeed", () => {
  it("is GitHub by default", () => {
    expect(resolveUpdateFeed({})).toBe(DEFAULT_UPDATE_FEED);
    expect(resolveUpdateFeed({ PRSLOY_UPDATE_FEED_URL: "http://127.0.0.1:9/" })).toBe(
      DEFAULT_UPDATE_FEED,
    );
  });

  it("serves a loopback feed only in the update e2e", () => {
    expect(
      resolveUpdateFeed({ PRSLOY_E2E: "1", PRSLOY_UPDATE_FEED_URL: "http://127.0.0.1:4567/feed" }),
    ).toEqual({ provider: "generic", url: "http://127.0.0.1:4567/feed" });
    expect(
      resolveUpdateFeed({ PRSLOY_E2E: "1", PRSLOY_UPDATE_FEED_URL: "http://localhost:4567/" }),
    ).toEqual({ provider: "generic", url: "http://localhost:4567/" });
  });

  it("never points at a remote or malformed feed", () => {
    for (const url of [
      "https://evil.example/feed",
      "http://127.0.0.1.evil.example/",
      "file:///C:/feed",
      "not a url",
    ]) {
      expect(resolveUpdateFeed({ PRSLOY_E2E: "1", PRSLOY_UPDATE_FEED_URL: url })).toBe(
        DEFAULT_UPDATE_FEED,
      );
    }
  });
});
