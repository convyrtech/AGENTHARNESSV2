import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { maskKey, PrsloyKeyStore, type SecretCipher } from "./key-store.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function keyPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "prsloy-key-"));
  dirs.push(dir);
  return join(dir, "nested", "gateway-key.bin");
}

/** Reversible fake cipher (XOR) so the test can prove the file is not plain text. */
function fakeCipher(available = true): SecretCipher {
  const xor = (buf: Buffer) => Buffer.from(buf.map((b) => b ^ 0x5a));
  return {
    isEncryptionAvailable: () => available,
    encryptString: (text) => xor(Buffer.from(`enc:${text}`, "utf8")),
    decryptString: (buf) => {
      const text = xor(buf).toString("utf8");
      if (!text.startsWith("enc:")) throw new Error("bad blob");
      return text.slice(4);
    },
  };
}

describe("PrsloyKeyStore", () => {
  it("round-trips an encrypted key and never writes it in plain text", () => {
    const path = keyPath();
    const store = new PrsloyKeyStore(path, fakeCipher());
    expect(store.read()).toBeUndefined();
    expect(store.write("  sk-prsloy-123456  ")).toBe(true);
    expect(readFileSync(path).toString("utf8")).not.toContain("sk-prsloy-123456");
    expect(new PrsloyKeyStore(path, fakeCipher()).read()).toBe("sk-prsloy-123456");
    store.clear();
    expect(existsSync(path)).toBe(false);
    expect(store.read()).toBeUndefined();
  });

  it("treats an undecryptable blob as no key", () => {
    const path = keyPath();
    new PrsloyKeyStore(path, fakeCipher()).write("sk-1");
    writeFileSync(path, "garbage");
    expect(new PrsloyKeyStore(path, fakeCipher()).read()).toBeUndefined();
  });

  it("keeps the key in memory only when the OS has no encryption", () => {
    const path = keyPath();
    const store = new PrsloyKeyStore(path, fakeCipher(false));
    expect(store.write("sk-mem")).toBe(false);
    expect(store.isMemoryOnly()).toBe(true);
    expect(store.read()).toBe("sk-mem");
    expect(existsSync(path)).toBe(false);
  });

  it("rejects empty keys", () => {
    expect(() => new PrsloyKeyStore(keyPath(), fakeCipher()).write("   ")).toThrow();
  });

  it("masks keys for display", () => {
    expect(maskKey("sk-abcdefgh1234")).toBe("sk-…1234");
    expect(maskKey("short")).toBe("…");
    expect(maskKey(undefined)).toBe("");
  });
});
