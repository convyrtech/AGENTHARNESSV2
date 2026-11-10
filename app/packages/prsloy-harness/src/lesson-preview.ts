import { parseJsonl } from "./reflect.ts";

export const PREVIEW_MODEL = "minimax-m3.1-flash";
export const PREVIEW_MAX_TOKENS = 768;

// Only these fixed, code-owned values may be copied into a model request.
const signals = {
  "delegate.model_ref": {
    sig: "unavailable-openai-model",
    meaning:
      "Delegate rejected an unavailable or incompatible model reference. Models are selected as configured provider/model pairs.",
  },
  "delegate.no_changes": {
    sig: "worker-no-file-change",
    meaning:
      "Worker completed but every allowed file remained byte-identical. Delegate requires an actual patch before running the acceptance check and independent review.",
  },
} as const;

type Signal = keyof typeof signals;
type PreviewSignal = { id: Signal; failures: number; recoveries: number };
type PreviewEvent =
  | { key: string; kind: "turn.end" }
  | { key: string; scope: string; kind: "delegate.verified" }
  | { key: string; scope: string | undefined; kind: Signal };
type Decision =
  | { id: Signal; decision: "draft"; cause: string; lesson: string }
  | { id: Signal; decision: "none"; cause: string };

function previewEvent(row: Record<string, unknown>): PreviewEvent | undefined {
  const { surface, project, session, kind, sig, scope } = row;
  if (
    surface !== "code" ||
    typeof project !== "string" ||
    !/^[a-f0-9]{16}$/u.test(project) ||
    typeof session !== "string" ||
    !session
  )
    return undefined;
  const key = JSON.stringify([project, session]);
  if (kind === "turn.end") return { key, kind };
  const scopeKey = typeof scope === "string" && /^[a-f0-9]{32}$/u.test(scope) ? scope : undefined;
  if (kind === "delegate.verified" && sig === "check-review" && scopeKey)
    return { key, scope: scopeKey, kind };
  if (
    (kind === "delegate.model_ref" || kind === "delegate.no_changes") &&
    signals[kind].sig === sig
  )
    return { key, scope: scopeKey, kind };
  return undefined;
}

export function collectPreviewSignals(raw: string): PreviewSignal[] {
  const pending = new Map<string, Map<string, Set<Signal>>>();
  const counts = new Map<Signal, PreviewSignal>();
  for (const event of parseJsonl(raw, previewEvent)) {
    const { key, kind } = event;
    if (kind === "turn.end") {
      pending.delete(key);
    } else if (kind === "delegate.verified") {
      const scopes = pending.get(key);
      for (const id of scopes?.get(event.scope) ?? []) counts.get(id)!.recoveries += 1;
      scopes?.delete(event.scope);
    } else {
      const current = counts.get(kind) ?? { id: kind, failures: 0, recoveries: 0 };
      current.failures += 1;
      counts.set(kind, current);
      if (!event.scope) continue;
      const scopes = pending.get(key) ?? new Map<string, Set<Signal>>();
      const failed = scopes.get(event.scope) ?? new Set<Signal>();
      failed.add(kind);
      scopes.set(event.scope, failed);
      pending.set(key, scopes);
    }
  }
  return [...counts.values()];
}

export function previewPrompt(candidates: PreviewSignal[]): string {
  const observations = candidates.map(({ id, failures, recoveries }) => ({
    id,
    meaning: signals[id].meaning,
    failures,
    recoveries,
  }));
  return [
    "Draft short coding-harness lessons in Russian using only the anonymized observations below.",
    "Recovery means a later delegation with the same files and acceptance command passed the check and independent review before the recorded turn end. This does not establish causality.",
    "For each observation, give one concrete action that could prevent recurrence. If the evidence does not support an actionable hint, use none. Never invent a diagnosis, a recovery action or an available model. Preserve scope, the acceptance check and independent review.",
    'Return only a JSON array with one object per id: {"id":"…","decision":"draft","cause":"…","lesson":"…"} or {"id":"…","decision":"none","cause":"…"}. Use at most 180 characters for cause and 220 for lesson.',
    JSON.stringify(observations),
  ].join("\n");
}

function boundedLine(value: unknown, limit: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= limit &&
    !/\p{Cc}/u.test(value)
  );
}

export function validatePreview(
  reply: unknown,
  candidates: PreviewSignal[],
): Decision[] | undefined {
  if (typeof reply !== "string") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed) || parsed.length !== candidates.length) return undefined;
  const expected = new Set(
    candidates.filter((candidate) => candidate.recoveries > 0).map(({ id }) => id),
  );
  const decisions: Decision[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
    const { id, decision, cause, lesson } = item as Record<string, unknown>;
    if (
      (id !== "delegate.model_ref" && id !== "delegate.no_changes") ||
      !expected.delete(id) ||
      !boundedLine(cause, 180)
    )
      return undefined;
    const keys = Object.keys(item);
    if (decision === "draft" && keys.length === 4 && boundedLine(lesson, 220)) {
      decisions.push({ id, decision, cause, lesson });
    } else if (decision === "none" && keys.length === 3 && !("lesson" in item)) {
      decisions.push({ id, decision, cause });
    } else return undefined;
  }
  return decisions;
}
