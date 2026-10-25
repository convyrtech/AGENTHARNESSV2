// Живая проверка второго мнения: три настоящих диффа (в одном — настоящая ошибка) идут к проверяющему другой
// семьи через прокси надёжности харнесса, ответ разбирается тем же кодом, что в приложении (parseVerdict:
// замечание засчитывается только с цитатой из диффа).
//
// Запуск (ключ шлюза — только из окружения, в вывод не попадает):
//   PRSLOY_GATEWAY_KEY=… node packages/prsloy-harness/scripts/review-live.mts
//   … --writer kimi-k3.1-pro          писатель (по нему выбирается проверяющий), можно несколько раз
//   … --base-url https://…/v1         другой шлюз (по умолчанию api.prsloy.online)
// Выход 0 — ошибка найдена, чистые диффы прошли; 1 — нет; 2 — не запустилось.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  PRSLOY_DEFAULT_BASE_URL,
  PRSLOY_MODELS,
  PRSLOY_PRICES_USD_PER_M,
} from "../../../apps/desktop/src/shared/prsloy-config.ts";
import { ReliabilityProxy } from "../src/reliability-proxy.ts";
import {
  changedLines,
  clipDiff,
  parseVerdict,
  pickModel,
  reviewerFor,
  reviewPrompt,
} from "../src/second-opinion.ts";

interface Case {
  name: string;
  task: string;
  checks: string;
  diff: string;
  expect: "PASS" | "FAIL";
}

// 1. Настоящая ошибка: страница 1 пропускает первые 10 элементов, а slice(start, 10) — это «до 10-го», не «10 штук».
const PAGINATION_BUG: Case = {
  name: "пагинация с ошибкой",
  task: "Добавь пагинацию в /api/items: ?page=1 — первые 10 товаров, ?page=2 — следующие 10.",
  checks: "своей проверки у проекта нет; синтаксис правленых файлов проверен после каждой правки",
  expect: "FAIL",
  diff: `diff --git a/server.js b/server.js
index 3b18e51..9c2f0aa 100644
--- a/server.js
+++ b/server.js
@@ -1,12 +1,16 @@
 const express = require("express");
 const items = require("./items.json");

 const app = express();
+const PAGE_SIZE = 10;

 app.get("/api/items", (req, res) => {
-  res.json(items);
+  const page = Number(req.query.page) || 1;
+  const start = page * PAGE_SIZE;
+  res.json({ page, total: items.length, items: items.slice(start, PAGE_SIZE) });
 });

 app.listen(3000, () => {
   console.log("http://localhost:3000");
 });
`,
};

// 2. Чистый: подвал лендинга с контактами.
const FOOTER_OK: Case = {
  name: "подвал лендинга",
  task: "Добавь на лендинг подвал: телефон, почта и ссылка на Telegram.",
  checks: "своей проверки у проекта нет; синтаксис правленых файлов проверен после каждой правки",
  expect: "PASS",
  diff: `diff --git a/index.html b/index.html
index 1a2b3c4..5d6e7f8 100644
--- a/index.html
+++ b/index.html
@@ -40,6 +40,14 @@
       <a class="button" href="#order">Заказать</a>
     </section>
   </main>
+  <footer class="footer">
+    <p>Телефон: <a href="tel:+79991234567">+7 999 123-45-67</a></p>
+    <p>Почта: <a href="mailto:hello@example.ru">hello@example.ru</a></p>
+    <p>Telegram: <a href="https://t.me/example_shop" target="_blank" rel="noopener">@example_shop</a></p>
+  </footer>
 </body>
 </html>
diff --git a/style.css b/style.css
index 0f1e2d3..4c5b6a7 100644
--- a/style.css
+++ b/style.css
@@ -88,3 +88,13 @@ main {
   max-width: 960px;
   margin: 0 auto;
 }
+
+.footer {
+  padding: 32px 16px;
+  text-align: center;
+  color: #555;
+}
+
+.footer a {
+  color: inherit;
+}
`,
};

// 3. Чистый: slugify на Python с тестами, pytest зелёный.
const SLUGIFY_OK: Case = {
  name: "slugify с тестами",
  task: "Сделай функцию slugify: «Привет, Мир!» → «privet-mir», пробелы и знаки — в дефис, без дефисов по краям.",
  checks: "`python3 -m pytest -q -x`: прошла (код 0)\n3 passed in 0.02s",
  expect: "PASS",
  diff: `diff --git a/slug.py b/slug.py
new file mode 100644
index 0000000..b1c2d3e
--- /dev/null
+++ b/slug.py
@@ -0,0 +1,14 @@
+import re
+
+TRANSLIT = dict(zip(
+    "абвгдеёжзийклмнопрстуфхцчшщъыьэюя",
+    ["a", "b", "v", "g", "d", "e", "e", "zh", "z", "i", "y", "k", "l", "m", "n", "o", "p",
+     "r", "s", "t", "u", "f", "kh", "ts", "ch", "sh", "shch", "", "y", "", "e", "yu", "ya"],
+))
+
+
+def slugify(text: str) -> str:
+    lowered = text.lower()
+    latin = "".join(TRANSLIT.get(ch, ch) for ch in lowered)
+    return re.sub(r"[^a-z0-9]+", "-", latin).strip("-")
+
diff --git a/test_slug.py b/test_slug.py
new file mode 100644
index 0000000..c4d5e6f
--- /dev/null
+++ b/test_slug.py
@@ -0,0 +1,13 @@
+from slug import slugify
+
+
+def test_cyrillic():
+    assert slugify("Привет, Мир!") == "privet-mir"
+
+
+def test_edges():
+    assert slugify("  --Hello World--  ") == "hello-world"
+
+
+def test_digits():
+    assert slugify("Заказ №42") == "zakaz-42"
`,
};

const CASES = [PAGINATION_BUG, FOOTER_OK, SLUGIFY_OK];

function costUsd(model: string, usage: Record<string, number> | undefined): number {
  const price = PRSLOY_PRICES_USD_PER_M[model];
  if (!price || !usage) return 0;
  const cached = usage.prompt_tokens_details_cached ?? 0;
  const input = (usage.prompt_tokens ?? 0) - cached;
  return (
    (input * price.input +
      cached * (price.cacheRead ?? price.input) +
      (usage.completion_tokens ?? 0) * price.output) /
    1_000_000
  );
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      writer: { type: "string", multiple: true },
      "base-url": { type: "string" },
    },
  });
  const key = process.env.PRSLOY_GATEWAY_KEY ?? process.env.PRSLOY_KEY;
  if (!key) {
    console.error("Нужен ключ шлюза в PRSLOY_GATEWAY_KEY.");
    return 2;
  }
  const upstream = values["base-url"] ?? PRSLOY_DEFAULT_BASE_URL;
  const writers = values.writer?.length ? values.writer : ["deepseek-v4.1-flash-1017"];
  const ids = PRSLOY_MODELS.map((m) => ({ id: m.id }));

  const proxy = new ReliabilityProxy();
  await proxy.start();
  const metrics = join(mkdtempSync(join(tmpdir(), "prsloy-review-live-")), "proxy.jsonl");
  const base = proxy.route(upstream, metrics, "review-live");
  let ok = true;
  let total = 0;
  let calls = 0;
  try {
    for (const writer of writers) {
      const prefix = reviewerFor(writer);
      const reviewer = prefix ? pickModel(ids, prefix)?.id : undefined;
      if (!reviewer) {
        console.error(`Для ${writer} нет пары проверяющего.`);
        return 2;
      }
      console.log(`\nПисатель ${writer} → проверяющий ${reviewer}`);
      for (const c of CASES) {
        const diff = clipDiff(c.diff);
        const started = Date.now();
        calls += 1;
        const response = await fetch(`${base}/chat/completions`, {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify({
            model: reviewer,
            max_tokens: 16_000,
            messages: [
              { role: "user", content: reviewPrompt({ task: c.task, diff, checks: c.checks }) },
            ],
          }),
        });
        const seconds = ((Date.now() - started) / 1000).toFixed(1);
        const body = (await response.json().catch(() => ({}))) as {
          choices?: { message?: { content?: string } }[];
          usage?: {
            prompt_tokens?: number;
            completion_tokens?: number;
            prompt_tokens_details?: { cached_tokens?: number };
          };
          error?: { message?: string };
        };
        if (!response.ok || body.error) {
          ok = false;
          console.log(
            `  ✗ ${c.name}: шлюз ответил ${response.status} ${body.error?.message ?? ""}`,
          );
          continue;
        }
        const text = body.choices?.[0]?.message?.content ?? "";
        const usage = body.usage && {
          prompt_tokens: body.usage.prompt_tokens ?? 0,
          completion_tokens: body.usage.completion_tokens ?? 0,
          prompt_tokens_details_cached: body.usage.prompt_tokens_details?.cached_tokens ?? 0,
        };
        const usd = costUsd(reviewer, usage);
        total += usd;
        const verdict = parseVerdict(text, diff);
        const pass = verdict.verdict === c.expect && !verdict.invalid;
        ok &&= pass;
        console.log(
          `  ${pass ? "✓" : "✗"} ${c.name} (строк изменено: ${changedLines(c.diff)}): ${verdict.verdict}` +
            `${verdict.invalid ? " (ответ не разобран)" : ""}, ждали ${c.expect}; ` +
            `замечаний с цитатой ${verdict.items.length}, отброшено без цитаты ${verdict.rejected}; ` +
            `${seconds} с, $${usd.toFixed(5)}`,
        );
        for (const item of verdict.items)
          console.log(
            `      ${item.file}${item.line ? `:${item.line}` : ""} — ${item.problem}\n        «${item.evidence}»`,
          );
        if (!pass || verdict.invalid) console.log(`      ответ модели: ${text.slice(0, 600)}`);
      }
    }
  } finally {
    await proxy.close();
  }
  // Прокси дописывает метрики асинхронно — ждём последнюю строку.
  const read = () => {
    try {
      return readFileSync(metrics, "utf8").trim().split("\n").filter(Boolean);
    } catch {
      return [];
    }
  };
  let lines = read();
  for (let i = 0; i < 40 && lines.length < calls; i++) {
    await new Promise((r) => setTimeout(r, 50));
    lines = read();
  }
  console.log(
    `\nВызовов через прокси: ${lines.length}; всего $${total.toFixed(4)}; метрики: ${metrics}`,
  );
  console.log(ok ? "Итог: OK" : "Итог: есть расхождения");
  return ok ? 0 : 1;
}

process.exitCode = await main().catch((error: unknown) => {
  console.error(error);
  return 2;
});
