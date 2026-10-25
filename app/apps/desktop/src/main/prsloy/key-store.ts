/**
 * PRSLOY gateway key at rest: Electron `safeStorage` (DPAPI on Windows, Keychain on
 * macOS, libsecret/kwallet on Linux). The plain key exists only in main memory and in
 * the Agent Host (pi runtime key), never in auth.json / models.json.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** The slice of Electron `safeStorage` we use (injectable for tests). */
export interface SecretCipher {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export class PrsloyKeyStore {
  readonly #path: string;
  readonly #cipher: SecretCipher;
  /** Session-only key when the OS offers no encryption (never written in plain text). */
  #memoryOnly: string | undefined;

  constructor(path: string, cipher: SecretCipher) {
    this.#path = path;
    this.#cipher = cipher;
  }

  /** Decrypted key, or undefined when none is stored or it can no longer be decrypted. */
  read(): string | undefined {
    if (this.#memoryOnly) return this.#memoryOnly;
    if (!existsSync(this.#path)) return undefined;
    try {
      if (!this.#cipher.isEncryptionAvailable()) return undefined;
      const key = this.#cipher.decryptString(readFileSync(this.#path)).trim();
      return key || undefined;
    } catch {
      // Profile moved to another machine / OS user: DPAPI blob is unreadable. Ask again.
      return undefined;
    }
  }

  /** Store the key. Returns false when it could only be kept for this session. */
  write(key: string): boolean {
    const trimmed = key.trim();
    if (!trimmed) throw new Error("Empty key");
    if (!this.#cipher.isEncryptionAvailable()) {
      this.#memoryOnly = trimmed;
      rmSync(this.#path, { force: true });
      return false;
    }
    mkdirSync(dirname(this.#path), { recursive: true });
    const tmp = `${this.#path}.tmp-${process.pid}`;
    writeFileSync(tmp, this.#cipher.encryptString(trimmed), { mode: 0o600 });
    renameSync(tmp, this.#path);
    this.#memoryOnly = undefined;
    return true;
  }

  clear(): void {
    this.#memoryOnly = undefined;
    rmSync(this.#path, { force: true });
  }

  /** True when a key exists but is held in memory only (no OS encryption). */
  isMemoryOnly(): boolean {
    return this.#memoryOnly !== undefined;
  }
}

/** Mask for logs / UI: `sk-…abcd`. */
export function maskKey(key: string | undefined): string {
  if (!key) return "";
  const tail = key.slice(-4);
  return key.length <= 8 ? "…" : `${key.slice(0, 3)}…${tail}`;
}
