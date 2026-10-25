/**
 * IPC + service end to end in Node: electron is mocked, everything else is real —
 * a6proxy.py on a free port, run.py replaced by e2e/design/fake_run.py replaying the
 * recorded harness log, a venv that is the system python3.
 */
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DesignEventMessage } from "@zeno/contracts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";

type Handler = (event: unknown, ...args: unknown[]) => unknown;
const handlers = new Map<string, Handler>();
const sent: { channel: string; payload: unknown }[] = [];
let protocolHandler: ((req: Request) => Promise<Response>) | undefined;
let pickedPaths: string[] = [];
const quitHooks: (() => void)[] = [];

vi.mock("electron", () => ({
  app: { on: (name: string, fn: () => void) => name === "before-quit" && quitHooks.push(fn) },
  ipcMain: { handle: (ch: string, fn: Handler) => handlers.set(ch, fn) },
  protocol: {
    handle: (_s: string, fn: (req: Request) => Promise<Response>) => (protocolHandler = fn),
  },
  dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: pickedPaths }) },
  shell: { openPath: async () => "" },
}));

const { registerDesignIpc } = await import("./service.ts");

const HERE = import.meta.dirname;
const E2E = join(HERE, "../../../e2e/design");
const HARNESS = join(HERE, "../../../../../../playbooks/site/harness");
const python3 = (() => {
  try {
    return execFileSync("sh", ["-c", "command -v python3"]).toString().trim();
  } catch {
    return "";
  }
})();

const root = mkdtempSync(join(tmpdir(), "design-svc-"));
const project = join(root, "project");
const trusted = { senderFrame: { url: "file:///app/index.html" } };

function call(channel: string, ...args: unknown[]): Promise<unknown> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`no handler ${channel}`);
  return Promise.resolve(fn(trusted, ...args));
}

function eventsUntil(pred: (m: DesignEventMessage) => boolean, timeout = 20_000) {
  return new Promise<DesignEventMessage[]>((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const msgs = sent
        .filter((s) => s.channel === "prsloy:design:event")
        .map((s) => s.payload as DesignEventMessage);
      if (msgs.some(pred)) return resolve(msgs);
      if (Date.now() - start > timeout) return reject(new Error("timeout"));
      setTimeout(tick, 50);
    };
    tick();
  });
}

describe.skipIf(!python3 || process.platform === "win32")("design IPC", () => {
  beforeAll(() => {
    const bundle = join(root, "bundle");
    const harness = join(bundle, "playbooks", "site", "harness");
    mkdirSync(harness, { recursive: true });
    copyFileSync(join(E2E, "fake_run.py"), join(harness, "run.py"));
    copyFileSync(join(E2E, "recorded.jsonl"), join(harness, "recorded.jsonl"));
    cpSync(join(E2E, "fixtures"), join(harness, "fixtures"), { recursive: true });
    for (const f of ["a6proxy.py", "stages.json"]) copyFileSync(join(HARNESS, f), join(harness, f));
    const venv = join(root, "venv");
    mkdirSync(join(venv, "bin"), { recursive: true });
    symlinkSync(python3, join(venv, "bin", "python"));
    mkdirSync(project);
    process.env.PRSLOY_DESIGN_VENV = venv;
    process.env.PRSLOY_DESIGN_PI_BIN = '["true"]';
    registerDesignIpc({
      userDataPath: join(root, "userData"),
      bundleRoot: bundle,
      fallbackRoot: join(root, "docs"),
      getWindow: () =>
        ({
          isDestroyed: () => false,
          webContents: {
            send: (channel: string, payload: unknown) => sent.push({ channel, payload }),
          },
        }) as never,
      getGateway: () => ({ apiKey: "sk-test-key", baseUrl: "http://127.0.0.1:9/v1" }),
      basePython: () => python3,
      nodeExecutable: () => "node",
      piCliPath: async () => undefined,
      assertTrustedSender: (event) => {
        if (event !== (trusted as never)) throw new Error("untrusted sender");
      },
    });
  });

  afterAll(() => {
    for (const fn of quitHooks) fn();
  });

  const proxies = () =>
    execFileSync("ps", ["-eo", "stat=,args="])
      .toString()
      .split("\n")
      .filter(
        (l) => l.includes(join(root, "bundle")) && l.includes("a6proxy.py") && !l.startsWith("Z"),
      );

  it("registers only the design channels and refuses untrusted senders", () => {
    expect([...handlers.keys()].sort()).toEqual(
      ["cancel", "open-folder", "pick-files", "preview", "say", "setup", "status"].map(
        (c) => `prsloy:design:${c}`,
      ),
    );
    expect(() => handlers.get("prsloy:design:status")!({ senderFrame: null }, project)).toThrow(
      "untrusted sender",
    );
  });

  it("reports a fresh project: tools ready (test venv), empty history, key present", async () => {
    const status = (await call("prsloy:design:status", project)) as Record<string, unknown>;
    expect(status).toMatchObject({
      toolsReady: true,
      workspace: join(project, "prsloy-design"),
      running: false,
      history: [],
      needsKey: false,
    });
  });

  it("runs a turn: proxy up, key file gone, workspace initialised, events relayed", async () => {
    await call("prsloy:design:say", project, "сделай лендинг для кофейни «Зерно»", []);
    const msgs = await eventsUntil((m) => m.event.ev === "exit");
    expect(msgs.map((m) => m.event.ev)).toEqual(["user", "stage", "tool", "tool", "owner", "exit"]);
    const ws = join(project, "prsloy-design");
    expect(msgs.every((m) => m.workspace === ws)).toBe(true);
    expect(existsSync(join(ws, "harness", "state.json"))).toBe(true);
    // the key lived on disk only until a6proxy read it
    expect(readdirSync(join(root, "userData", "design", "proxy"))).toEqual([]);
    const models = JSON.parse(
      readFileSync(join(root, "userData", "design", "pi-agent", "models.json"), "utf8"),
    ) as { providers: { a6p: { baseUrl: string; apiKey: string } } };
    expect(models.providers.a6p.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    expect(models.providers.a6p.apiKey).toBe("local");
    expect(JSON.stringify(models)).not.toContain("sk-test-key");
  });

  it("passes picked files and serves the owner's pictures through the protocol", async () => {
    const logo = join(root, "logo.png");
    copyFileSync(join(E2E, "fixtures", "logo.png"), logo);
    pickedPaths = [logo];
    const picked = (await call("prsloy:design:pick-files")) as { token: string; name: string }[];
    expect(picked).toEqual([{ token: expect.any(String), name: "logo.png" }]);
    sent.length = 0;
    await call("prsloy:design:say", project, "вот логотип", [picked[0]!.token, "forged-token"]);
    const msgs = await eventsUntil((m) => m.event.ev === "exit");
    const user = msgs.find((m) => m.event.ev === "user")!.event;
    expect(user).toMatchObject({ text: "вот логотип", files: ["logo.png"] });
    const ws = join(project, "prsloy-design");
    expect(existsSync(join(ws, "materials", "logo.png"))).toBe(true);
    const owner = msgs.find((m) => m.event.ev === "owner")!.event;
    if (owner.ev !== "owner") throw new Error("no owner");
    expect(owner.options.map((o) => o.key)).toEqual(["A", "B", "C"]);
    expect(owner.files).toHaveLength(1);
    const file = owner.files[0]!;
    expect(file).toMatchObject({ path: "design/landing/00-moods.png", kind: "image" });
    const res = await protocolHandler!(new Request(file.url));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    const ranged = await protocolHandler!(
      new Request(file.url, { headers: { range: "bytes=0-7" } }),
    );
    expect(ranged.status).toBe(206);
    expect(new Uint8Array(await ranged.arrayBuffer())).toHaveLength(8);
    const outside = file.url.replace("design/landing/00-moods.png", "..%2F..%2Flogo.png");
    expect((await protocolHandler!(new Request(outside))).status).toBe(404);
  });

  it("keeps history across reopen and refuses a second turn while one runs", async () => {
    sent.length = 0;
    await call("prsloy:design:say", project, "долго", []);
    await eventsUntil((m) => m.event.ev === "stage");
    await expect(call("prsloy:design:say", project, "ещё", [])).rejects.toThrow("Уже работаю");
    const status = (await call("prsloy:design:status", project)) as {
      running: boolean;
      history: { ev: string }[];
    };
    expect(status.running).toBe(true);
    expect(status.history.filter((e) => e.ev === "owner")).toHaveLength(2);
    await call("prsloy:design:cancel", project);
    const msgs = await eventsUntil((m) => m.event.ev === "exit");
    expect(msgs.at(-1)!.event).toMatchObject({ ev: "exit", cancelled: true });
  });

  it("retries after stuck and previews the built page", async () => {
    sent.length = 0;
    await call("prsloy:design:say", project, "", [], true);
    const msgs = await eventsUntil((m) => m.event.ev === "exit");
    expect(msgs.map((m) => m.event.ev)).not.toContain("user");
    expect(msgs.map((m) => m.event.ev)).toContain("done");
    const preview = (await call("prsloy:design:preview", project)) as { url: string };
    expect(preview.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/landing\/$/);
    const html = await (await fetch(preview.url)).text();
    expect(html).toContain("Зерно");
  });

  it("app quit stops the proxy it started", async () => {
    expect(proxies()).toHaveLength(1);
    expect(quitHooks).toHaveLength(1);
    quitHooks[0]!();
    await new Promise((r) => setTimeout(r, 300));
    expect(proxies()).toEqual([]);
  });

  it("starts a workspace for the fallback folder when no project is open", async () => {
    const status = (await call("prsloy:design:status", undefined)) as { workspace: string };
    expect(status.workspace).toBe(join(root, "docs", "prsloy-design"));
  });
});
