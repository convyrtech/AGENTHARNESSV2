// Подключение прокси надёжности к провайдеру PRSLOY без правок хоста: на session_start расширение поднимает
// общий для процесса прокси и переопределяет baseUrl провайдера (pi.registerProvider с одним baseUrl сохраняет
// модели и ключ из models.json; ключ Pi шлёт заголовком, прокси передаёт его как есть).
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ResolvedOptions } from "./options.ts";
import { ReliabilityProxy, type ReliabilityOptions } from "./reliability-proxy.ts";

let shared: { proxy: ReliabilityProxy; ready: Promise<string> } | undefined;

/** Один прокси на процесс хоста: сессии и перезагрузки расширения его переиспользуют. */
export function sharedProxy(options: ReliabilityOptions = {}): {
  proxy: ReliabilityProxy;
  ready: Promise<string>;
} {
  if (!shared) {
    const proxy = new ReliabilityProxy(options);
    shared = { proxy, ready: proxy.start() };
  }
  return shared;
}

/** Для тестов: закрыть общий прокси. */
export async function closeSharedProxy(): Promise<void> {
  const current = shared;
  shared = undefined;
  await current?.proxy.close();
}

export function metricsPathFor(ctx: ExtensionContext, opts: ResolvedOptions): string {
  let dir: string | undefined;
  try {
    dir = ctx.sessionManager.getSessionDir();
  } catch {
    dir = undefined;
  }
  return join(dir || opts.outputDir, "prsloy-proxy.jsonl");
}

export function installReliability(pi: ExtensionAPI, opts: ResolvedOptions): void {
  if (opts.reliabilityProviders.length === 0) return;
  pi.on("session_start", async (_event, ctx) => {
    const { proxy, ready } = sharedProxy(opts.reliability);
    await ready;
    let session: string | undefined;
    try {
      session = ctx.sessionManager.getSessionId();
    } catch {
      session = undefined;
    }
    const models = ctx.modelRegistry.getAll();
    for (const provider of opts.reliabilityProviders) {
      const own = models.filter(
        (m) => m.provider === provider && m.api === "openai-completions" && m.baseUrl,
      );
      const baseUrl = own[0]?.baseUrl;
      if (!baseUrl) continue;
      // После перезагрузки baseUrl может быть уже нашим маршрутом — достаём из него исходный шлюз.
      const upstream = proxy.upstreamOf(baseUrl) ?? baseUrl;
      pi.registerProvider(provider, {
        baseUrl: proxy.route(upstream, metricsPathFor(ctx, opts), session),
      });
    }
  });
}
