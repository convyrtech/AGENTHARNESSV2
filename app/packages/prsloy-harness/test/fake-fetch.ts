// Подмена fetch для тестов поиска: таблица «адрес начинается с → ответ», все вызовы записываются.

export type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

function parseBody(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

/** fetch по таблице «адрес начинается с → ответ»; все вызовы записываются. */
export function fakeFetch(routes: [string, (c: Call) => Response][]) {
  const calls: Call[] = [];
  const impl = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    const headers = Object.fromEntries(
      Object.entries((init.headers as Record<string, string>) ?? {}),
    );
    const body = typeof init.body === "string" ? parseBody(init.body) : undefined;
    const call = { url, method: init.method ?? "GET", headers, body };
    calls.push(call);
    const route = routes.find(([prefix]) => url.startsWith(prefix));
    if (!route) throw new Error(`ECONNREFUSED ${url}`);
    return route[1](call);
  }) as typeof fetch;
  return { impl, calls };
}

export const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
