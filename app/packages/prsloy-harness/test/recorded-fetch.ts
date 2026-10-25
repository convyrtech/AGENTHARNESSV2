import { readFileSync } from "node:fs";
import { join } from "node:path";

// Ответы реестров, записанные 2026-10-25 (урезаны до полей, которые читает тул). Сеть в тестах не нужна:
// адрес, которого нет в записи, — ошибка.
const FIXTURE = JSON.parse(
  readFileSync(join(import.meta.dirname, "fixtures", "find-ready.json"), "utf8"),
) as Record<string, { status: number; body: unknown }>;

export function recordedFetch(calls: string[] = []): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : input.toString();
    calls.push(url);
    const hit = FIXTURE[url];
    if (!hit) throw new Error(`no live network in tests: ${url}`);
    return new Response(hit.body === null ? "" : JSON.stringify(hit.body), {
      status: hit.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}
