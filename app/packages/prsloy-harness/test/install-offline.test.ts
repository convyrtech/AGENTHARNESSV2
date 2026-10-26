// Установка пакетов без сети: карточка «Не скачались пакеты: нет связи» с «Повторить», строка модели.
import { describe, expect, it } from "vite-plus/test";
import {
  INSTALL_OFFLINE_CARD,
  INSTALL_OFFLINE_NOTE,
  INSTALL_OFFLINE_TYPE,
  installInstallOffline,
  isOfflineInstall,
} from "../src/install-offline.ts";
import { resolveOptions } from "../src/options.ts";
import { MockPi } from "./mock-pi.ts";

const NPM_DNS =
  "npm error code ENOTFOUND\nnpm error syscall getaddrinfo\nnpm error errno ENOTFOUND\nnpm error network request to https://registry.npmjs.org/express failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org";
const PIP_OFFLINE =
  "WARNING: Retrying (Retry(total=4, connect=None, read=None, redirect=None, status=None)) after connection broken by 'NewConnectionError('<pip._vendor.urllib3.connection.HTTPSConnection object>: Failed to establish a new connection: [Errno -3] Temporary failure in name resolution')': /simple/requests/\nERROR: Could not find a version that satisfies the requirement requests";

describe("install without network", () => {
  it("npm / pip / uv network errors after an install command; not a missing package, not other commands", () => {
    expect(isOfflineInstall("npm install express", NPM_DNS)).toBe(true);
    expect(isOfflineInstall("cd app && pnpm add zod", "ERR_SOCKET_TIMEOUT")).toBe(true);
    expect(isOfflineInstall(".venv/bin/python -m pip install requests", PIP_OFFLINE)).toBe(true);
    expect(
      isOfflineInstall(".venv/Scripts/pip.exe install flask", "Could not resolve host: pypi.org"),
    ).toBe(true);
    expect(isOfflineInstall("uv pip install httpx", "error: Failed to fetch: ETIMEDOUT")).toBe(
      true,
    );
    // Пакета нет — это не сеть.
    expect(
      isOfflineInstall(
        "npm install expresss",
        "npm error 404 Not Found - GET https://registry.npmjs.org/expresss",
      ),
    ).toBe(false);
    expect(
      isOfflineInstall(
        "pip install nosuchpkg",
        "ERROR: No matching distribution found for nosuchpkg",
      ),
    ).toBe(false);
    // Не установка.
    expect(
      isOfflineInstall("curl https://example.com", "Could not resolve host: example.com"),
    ).toBe(false);
  });

  it("one card per user message with retry; the model gets one honest line on every such failure", async () => {
    const pi = new MockPi();
    installInstallOffline(pi.api, resolveOptions({ profile: "code" }));
    await pi.userPrompt("сделай сайт на express");
    const fail = () =>
      pi.toolResult({
        toolName: "bash",
        input: { command: "npm install express" },
        text: NPM_DNS,
        isError: true,
      });
    const first = await fail();
    expect(first.text).toContain(INSTALL_OFFLINE_NOTE);
    await fail();
    expect(pi.sent.filter((m) => m.customType === INSTALL_OFFLINE_TYPE)).toEqual([
      {
        customType: INSTALL_OFFLINE_TYPE,
        content: INSTALL_OFFLINE_CARD,
        display: true,
        details: { command: "npm install express", retry: true },
      },
    ]);
    await pi.userPrompt("попробуй ещё раз");
    await fail();
    expect(pi.sent.filter((m) => m.customType === INSTALL_OFFLINE_TYPE)).toHaveLength(2);
    // Успешная установка и чужая ошибка — без карточки.
    const ok = await pi.toolResult({
      toolName: "bash",
      input: { command: "npm install" },
      text: "added 3 packages",
    });
    expect(ok.modified).toBe(false);
  });
});
