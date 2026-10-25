// Copyright 2026 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     https://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//
// Ported from google-research/harness2 (commit 1cfe254), harness2/core/context.py:399-518
// (`assert_no_leak_paths`, `GRADER_VERDICT_MARKERS`, `assert_no_grader_verdicts`,
// `assert_tree_has_no_grader_verdicts`).
// Modified by PRSLOY, 2026-10-25: rewritten in TypeScript for the offline harness tuner (#33); the markers are
// our bench's grader — check.mjs, its output and the bench report fields — instead of harness2's eval summaries;
// an extra check refuses context files that contain lines of any check.mjs verbatim.
//
// Тripwire на границе чтения редактора, а не сама защита: если сработал — ищи путь, которым ответ попал в
// контекст, а не расширяй список меток.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** Пути, которые никогда не попадают в контекст редактора: проверка стенда, сценарий фейковой модели, отчёты. */
export const LEAK_PATH_PATTERNS: readonly RegExp[] = [
  /(?:^|\/)check\.m?js$/,
  /(?:^|\/)fake\.json$/,
  /(?:^|\/)bench-[^/]*\.(?:json|md)$/,
  /(?:^|\/)expected[^/]*$/,
];

/** Следы вердикта проверки: поля отчёта стенда и его строки, слова «проверяющего». */
export const GRADER_VERDICT_MARKERS: readonly string[] = [
  "check.mjs",
  '"ok": true',
  '"ok": false',
  '"ok":true',
  '"ok":false',
  '"unexpected"',
  '"expectedOutcome"',
  '"totals"',
  "Итого: прошло",
  "the grader expects",
  "проверка стенда",
];

const SCAN_SUFFIXES = new Set([
  ".md",
  ".txt",
  ".json",
  ".jsonl",
  ".csv",
  ".tsv",
  ".yaml",
  ".yml",
  ".html",
  ".htm",
  ".log",
  ".py",
  ".js",
  ".mjs",
  ".ts",
  ".sh",
  ".xml",
  ".ini",
  ".toml",
  ".patch",
  ".diff",
  "",
]);

function walk(root: string): string[] {
  const out: string[] = [];
  const go = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) go(p);
      else out.push(p);
    }
  };
  go(root);
  return out.sort();
}

const rel = (root: string, p: string) => relative(root, p).split(sep).join("/");
const suffix = (p: string) => /\.[^./\\]+$/.exec(p)?.[0].toLowerCase() ?? "";

/** Отказ, если в дереве контекста есть файл по пути из списка утечек (ответы, проверки, отчёты). */
export function assertNoLeakPaths(
  root: string,
  patterns: readonly RegExp[] = LEAK_PATH_PATTERNS,
): void {
  const hits = walk(root)
    .map((p) => rel(root, p))
    .filter((r) => patterns.some((re) => re.test(r)));
  if (hits.length) {
    throw new Error(`answer-key path(s) would enter model context: ${hits.slice(0, 8).join(", ")}`);
  }
}

function markerHit(
  name: string,
  body: string | undefined,
  markers: readonly string[],
): string | undefined {
  for (const m of markers) {
    if (name.includes(m))
      return `${JSON.stringify(name)} matched marker ${JSON.stringify(m)} in its NAME`;
  }
  if (body === undefined || !SCAN_SUFFIXES.has(suffix(name))) return undefined;
  for (const m of markers) {
    const at = body.indexOf(m);
    if (at >= 0) {
      return `${JSON.stringify(name)} contains marker ${JSON.stringify(m)} at offset ${at} (${JSON.stringify(body.slice(Math.max(0, at - 60), at + 120))})`;
    }
  }
  return undefined;
}

/** Отказ, если в дереве контекста есть вывод проверки — по имени файла и по содержимому. */
export function assertNoGraderVerdicts(
  root: string,
  markers: readonly string[] = GRADER_VERDICT_MARKERS,
): void {
  for (const p of walk(root)) {
    let body: string | undefined;
    try {
      body = SCAN_SUFFIXES.has(suffix(p)) ? readFileSync(p, "utf8") : undefined;
    } catch {
      body = undefined;
    }
    const hit = markerHit(rel(root, p), body, markers);
    if (hit) {
      throw new Error(
        `grader verdict would enter model context: ${hit}. The tripwire fired — this is a leak, not a false positive to widen around. Find the read path that produced it.`,
      );
    }
  }
}

/** То же для дерева обвязки, которое написал редактор (путь → текст), до пробы и хранения. */
export function assertTreeHasNoGraderVerdicts(
  tree: Readonly<Record<string, string>>,
  markers: readonly string[] = GRADER_VERDICT_MARKERS,
): void {
  for (const name of Object.keys(tree).sort()) {
    const hit = markerHit(name, tree[name], markers);
    if (hit) {
      throw new Error(
        `harness file ${hit}; remove or rename that string — files carrying it cannot be served as evidence to later tasks`,
      );
    }
  }
}

/** Строки проверок стенда (check.mjs) длиннее `min`: ни одна не должна встретиться в контексте дословно. */
export function checkFingerprints(checkFiles: readonly string[], min = 24): string[] {
  const lines = new Set<string>();
  for (const f of checkFiles) {
    for (const line of readFileSync(f, "utf8").split("\n")) {
      const t = line.trim();
      if (t.length >= min && !/^(?:\/\/|\*|import |export |}|\)|return\b)/.test(t)) lines.add(t);
    }
  }
  return [...lines];
}

/** Отказ, если в контексте есть дословная строка какого-либо check.mjs (ответ, пересказанный кодом проверки). */
export function assertNoCheckText(root: string, fingerprints: readonly string[]): void {
  if (!fingerprints.length) return;
  for (const p of walk(root)) {
    if (!SCAN_SUFFIXES.has(suffix(p))) continue;
    const body = readFileSync(p, "utf8");
    const hit = fingerprints.find((line) => body.includes(line));
    if (hit) {
      throw new Error(
        `check.mjs text would enter model context: ${JSON.stringify(rel(root, p))} contains ${JSON.stringify(hit.slice(0, 80))}. Find the read path that produced it.`,
      );
    }
  }
}
