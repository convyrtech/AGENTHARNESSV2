import { readFileSync } from "node:fs";
import { join } from "node:path";

// Ответы реестров, записанные 2026-10-25 (урезаны до полей, которые читает тул). Сеть в тестах не нужна:
// адрес, которого нет в записи, — ошибка.
const FIXTURE = JSON.parse(
  readFileSync(join(import.meta.dirname, "fixtures", "find-ready.json"), "utf8"),
) as Record<string, { status: number; body: unknown }>;

/**
 * OSV.dev — один адрес на все пакеты (POST): ответ по «пакет@версия» из тела. Нет в записи — уязвимостей нет.
 * lodash@4.17.15 — записанный 2026-10-26 ответ, урезанный до id, aliases и severity.
 */
export const OSV_FIXTURE: Record<string, unknown> = {
  "lodash@4.17.15": {
    vulns: [
      {
        id: "GHSA-35jh-r3h4-6jhm",
        aliases: ["CVE-2021-23337"],
        database_specific: { severity: "HIGH" },
      },
      {
        id: "GHSA-29mw-wpgm-hmr9",
        aliases: ["CVE-2020-28500"],
        database_specific: { severity: "MODERATE" },
      },
    ],
  },
  "evil-pkg@1.0.0": {
    vulns: [
      {
        id: "GHSA-xxxx-yyyy-zzzz",
        aliases: ["CVE-2026-0001"],
        database_specific: { severity: "CRITICAL" },
      },
    ],
  },
};

export function recordedFetch(calls: string[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString();
    calls.push(url);
    if (url === "https://api.osv.dev/v1/query") {
      const q = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
        package?: { name?: string };
        version?: string;
      };
      return new Response(JSON.stringify(OSV_FIXTURE[`${q.package?.name}@${q.version}`] ?? {}), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    const hit = FIXTURE[url];
    if (!hit) throw new Error(`no live network in tests: ${url}`);
    return new Response(hit.body === null ? "" : JSON.stringify(hit.body), {
      status: hit.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}
