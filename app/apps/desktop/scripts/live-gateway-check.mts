// Живой шлюз PRSLOY через тот же код провайдера, что в приложении (src/main/prsloy/live-check.ts):
// для каждой текстовой модели из /v1/models — поток, рассуждение по нашему compat, max_tokens 128k
// (и ступени 64k/32k при 400), usage и цена, вызов инструмента read и ответ по его результату.
// Не больше трёх коротких запросов на модель.
//
//   PRSLOY_GATEWAY_KEY=… node apps/desktop/scripts/live-gateway-check.mts
//   … --base-url https://api.prsloy.online/v1   (по умолчанию PRSLOY_BASE_URL или прод)
//   … --model qwen3.8-max                        (только эти модели; можно несколько)
//   … --out live-gateway.json                    (куда писать JSON; по умолчанию рядом, с временем)
//
// Ключ берётся только из окружения; в вывод и файлы не попадает (заменяется на ***).
// Выход 0 — все проверки ✅ или —; 1 — есть ❌; 2 — не запустилось.
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { formatLiveReport, runLiveGatewayCheck } from "../src/main/prsloy/live-check.ts";

const args = process.argv.slice(2);
const option = (name: string) => {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++)
    if (args[i] === name && args[i + 1]) values.push(args[++i]!);
  return values;
};
const key = process.env.PRSLOY_GATEWAY_KEY?.trim();
if (!key) {
  console.error("Нужен PRSLOY_GATEWAY_KEY в окружении.");
  process.exit(2);
}
const baseUrl =
  option("--base-url")[0] ?? process.env.PRSLOY_BASE_URL ?? "https://api.prsloy.online/v1";
const out = resolve(
  option("--out")[0] ?? `live-gateway-${new Date().toISOString().replace(/[:.]/gu, "-")}.json`,
);

try {
  const report = await runLiveGatewayCheck({
    baseUrl,
    apiKey: key,
    models: option("--model"),
    log: (line) => console.error(line),
  });
  const json = JSON.stringify(report, null, 2).split(key).join("***");
  writeFileSync(out, `${json}\n`);
  console.log(formatLiveReport(report).split(key).join("***"));
  console.log(`\nJSON: ${out}`);
  const failed = report.rows.some((row) =>
    Object.values(row).some((v) => typeof v === "object" && v.ok === false),
  );
  process.exit(failed ? 1 : 0);
} catch (error) {
  const text = error instanceof Error ? error.message : String(error);
  console.error(`Не запустилось: ${text.split(key).join("***")}`);
  process.exit(2);
}
