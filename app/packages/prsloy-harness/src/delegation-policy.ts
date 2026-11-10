import { parsePatch } from "./gate-signals.ts";

export interface DelegateRequest {
  task: string;
  paths: string[];
  check: string;
}

export function validateDelegateRequest(input: unknown): DelegateRequest {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Invalid delegate request");
  const value = input as Record<string, unknown>;
  if (
    typeof value.task !== "string" ||
    typeof value.check !== "string" ||
    !Array.isArray(value.paths)
  )
    throw new Error("Invalid delegate request");
  const task = value.task.trim();
  const check = value.check.trim();
  if (
    !task ||
    task.length > 6000 ||
    !check ||
    check.length > 2000 ||
    value.paths.length < 1 ||
    value.paths.length > 30
  )
    throw new Error("Invalid delegate request");
  const paths = value.paths.map((item) => {
    if (typeof item !== "string" || !item.trim()) throw new Error("Invalid delegate path");
    const path = item.trim().replace(/\\/g, "/");
    const segments = path.split("/");
    if (
      path.startsWith("/") ||
      /^[a-z]:/i.test(path) ||
      path.includes(":") ||
      segments.some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          /[<>:"|?*]/.test(part) ||
          part.split("").some((c) => c.charCodeAt(0) < 32) ||
          /[ .]$/.test(part) ||
          /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part) ||
          /^\.env/i.test(part) ||
          /^\.git$/i.test(part) ||
          /credentials?/i.test(part),
      )
    )
      throw new Error("Invalid delegate path");
    return path;
  });
  return { task, paths, check };
}

export function modelFamily(modelRef: string): string | undefined {
  if (typeof modelRef !== "string") return undefined;
  const id = modelRef.slice(modelRef.lastIndexOf("/") + 1).toLowerCase();
  if (/^(gpt|o1|o3|o4|codex)/.test(id)) return "openai";
  if (/^(claude|opus|fable)/.test(id)) return "anthropic";
  for (const family of ["kimi", "minimax", "deepseek", "gemini", "qwen", "grok", "glm"])
    if (id.startsWith(family)) return family;
  return undefined;
}

export function differentModelFamilies(a: string, b: string): boolean {
  const left = modelFamily(a);
  const right = modelFamily(b);
  return left !== undefined && right !== undefined && left !== right;
}

export interface ReviewFinding {
  file: string;
  line: number;
  problem: string;
  evidence: string;
}
export interface DelegatedReview {
  verdict: "PASS" | "FAIL";
  items: ReviewFinding[];
}

function diffEvidence(diff: string): Map<string, Map<number, Set<string>>> {
  const result = new Map<string, Map<number, Set<string>>>();
  let file: string | undefined;
  let oldLine = 0;
  let newLine = 0;
  for (const line of diff.split("\n")) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (header) {
      file = header[2];
      oldLine = 0;
      newLine = 0;
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      continue;
    }
    if (!file || (!oldLine && !newLine) || line.startsWith("\\ No newline")) continue;
    const byLine = result.get(file) ?? new Map<number, Set<string>>();
    const add = (number: number, content: string) => {
      const contents = byLine.get(number) ?? new Set<string>();
      contents.add(content);
      byLine.set(number, contents);
    };
    if (line.startsWith("+++")) continue;
    if (line.startsWith("+")) add(newLine++, line.slice(1));
    else if (line.startsWith("-")) add(oldLine++, line.slice(1));
    else if (line.startsWith(" ")) {
      add(newLine++, line.slice(1));
      oldLine++;
    } else continue;
    result.set(file, byLine);
  }
  return result;
}

export function parseDelegatedReview(text: string, diff: string): DelegatedReview | undefined {
  if (typeof text !== "string" || typeof diff !== "string") return undefined;
  const block = /^\s*```json\s*\n([\s\S]*?)\n```\s*$/.exec(text);
  const source = block ? block[1]! : text.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const review = parsed as Record<string, unknown>;
  if ((review.verdict !== "PASS" && review.verdict !== "FAIL") || !Array.isArray(review.items))
    return undefined;
  if (review.verdict === "PASS")
    return review.items.length === 0 ? { verdict: "PASS", items: [] } : undefined;
  if (!review.items.length || review.items.length > 10) return undefined;
  const files = new Set(parsePatch(diff).map((entry) => entry.file));
  const evidenceByLine = diffEvidence(diff);
  const items: ReviewFinding[] = [];
  for (const item of review.items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
    const finding = item as Record<string, unknown>;
    if (
      typeof finding.file !== "string" ||
      !files.has(finding.file) ||
      !Number.isInteger(finding.line) ||
      (finding.line as number) <= 0 ||
      typeof finding.problem !== "string" ||
      !finding.problem.trim() ||
      finding.problem.length > 1200 ||
      typeof finding.evidence !== "string" ||
      !finding.evidence ||
      finding.evidence.length > 2000 ||
      !evidenceByLine
        .get(finding.file)
        ?.get(finding.line as number)
        ?.has(finding.evidence)
    )
      return undefined;
    items.push({
      file: finding.file,
      line: finding.line as number,
      problem: finding.problem,
      evidence: finding.evidence,
    });
  }
  return { verdict: "FAIL", items };
}

export type DelegateStatus =
  | "verified"
  | "needs_changes"
  | "unverified"
  | "cancelled"
  | "budget_exceeded"
  | "failed";
export interface VerificationResult {
  command: string;
  exitCode: number | null;
  cancelled: boolean;
  error?: string;
}

export function decideDelegateStatus(input: {
  cancelled: boolean;
  budgetExceeded: boolean;
  workerFailed: boolean;
  check: VerificationResult;
  review: DelegatedReview | undefined;
  reviewedDigest: string | undefined;
  currentDigest: string;
  differentFamily: boolean;
}): DelegateStatus {
  if (input.cancelled) return "cancelled";
  if (input.budgetExceeded) return "budget_exceeded";
  if (input.workerFailed) return "failed";
  const review = input.review;
  if (
    input.check.cancelled ||
    input.check.exitCode !== 0 ||
    input.check.error ||
    !input.check.command.trim() ||
    !review ||
    !(
      (review.verdict === "PASS" && review.items.length === 0) ||
      (review.verdict === "FAIL" && review.items.length > 0)
    ) ||
    !input.differentFamily ||
    !input.reviewedDigest ||
    !input.currentDigest ||
    input.reviewedDigest !== input.currentDigest
  )
    return "unverified";
  return review.verdict === "FAIL" ? "needs_changes" : "verified";
}
