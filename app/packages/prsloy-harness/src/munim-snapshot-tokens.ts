import { randomUUID } from "node:crypto";

const BACKEND_ELEMENT_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const TOKEN =
  /^munim_v1\.([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.(0|[1-9][0-9]{0,5})$/u;
const MAX_ELEMENTS = 100_000;

export interface MunimSnapshotTokens {
  readonly generationId: string;
  readonly tokens: readonly string[];
}

type CurrentSnapshot = {
  pid: number;
  generationId: string;
  backendIdsByToken: Map<string, string>;
};

/**
 * Maps Munim's reusable element IDs to unpredictable, snapshot-scoped tokens.
 * A failed issue invalidates the prior snapshot so malformed backend output
 * can never leave old handles actionable.
 */
export class MunimSnapshotTokenStore {
  private current: CurrentSnapshot | undefined;

  issue(pid: unknown, backendElementIds: unknown): MunimSnapshotTokens | undefined {
    this.invalidate();
    if (!isPid(pid) || !Array.isArray(backendElementIds) || backendElementIds.length > MAX_ELEMENTS)
      return undefined;

    const ids: string[] = [];
    const seen = new Set<string>();
    for (const value of backendElementIds) {
      if (typeof value !== "string" || !BACKEND_ELEMENT_ID.test(value) || seen.has(value))
        return undefined;
      seen.add(value);
      ids.push(value);
    }

    const generationId = randomUUID();
    const backendIdsByToken = new Map<string, string>();
    const tokens = ids.map((backendId, index) => {
      const token = `munim_v1.${generationId}.${index}`;
      backendIdsByToken.set(token, backendId);
      return token;
    });

    // Publish the new snapshot only after validation and all mappings succeed.
    this.current = { pid, generationId, backendIdsByToken };
    return { generationId, tokens };
  }

  resolve(token: unknown, pid: unknown): string | undefined {
    const current = this.current;
    if (
      !current ||
      !isPid(pid) ||
      pid !== current.pid ||
      typeof token !== "string" ||
      !TOKEN.test(token)
    )
      return undefined;
    return current.backendIdsByToken.get(token);
  }

  invalidate(): void {
    this.current = undefined;
  }
}

function isPid(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
