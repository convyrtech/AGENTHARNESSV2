// Расширение Pi для базы A набора «Исследовать» (research/26 §4.10): только web_search и web_fetch из харнесса
// (R1), поставщик поиска — из файла, путь в BENCH_RESEARCH_CONFIG ({"provider": "deepseek", "key": "…"} и т. п.).
// Это стенд на машине дирижёра: в приложении ключ поиска идёт другим путём (safeStorage → хост) и в окружение
// агента не попадает.
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveOptions } from "../../app/packages/prsloy-harness/src/options.ts";
import type { SearchConfig } from "../../app/packages/prsloy-harness/src/research/search.ts";
import { installResearch } from "../../app/packages/prsloy-harness/src/research/tools.ts";

export default function benchResearch(pi: ExtensionAPI): void {
  const path = process.env.BENCH_RESEARCH_CONFIG;
  if (!path) throw new Error("BENCH_RESEARCH_CONFIG: путь к файлу с поставщиком поиска");
  const cfg = JSON.parse(readFileSync(path, "utf8")) as {
    provider: string;
    key?: string;
    folderId?: string;
    url?: string;
    gatewayUrl?: string;
  };
  const { gatewayUrl, ...search } = cfg;
  installResearch(
    pi,
    resolveOptions({ profile: "code", outputDir: process.env.BENCH_RESEARCH_OUT ?? join(tmpdir(), "bench-research") }),
    {
      enabled: true,
      search: search as SearchConfig,
      ...(gatewayUrl ? { gatewayUrl } : {}),
    },
  );
}
