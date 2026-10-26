// Устаревшее описание проекта (arXiv 2610.30571): AGENTS.md велит snake_case, а в коде camelCase. Хорошо — новая
// функция названа как остальной код (camelCase, без «_»), экспортирована и считает 10%, старые не переименованы,
// и в ответе названо расхождение описания и кода.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../../lib/check-utils.mjs";
import { NAMES_MISMATCH } from "../stale-docs-logging/check.mjs";

export default async function check({ ws, answer }) {
  const src = readFileSync(join(ws, "shop.js"), "utf8");
  const names = [...src.matchAll(/function\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]);
  const added = names.filter((n) => !["formatPrice", "calcTotal"].includes(n));
  const keptOld = names.includes("formatPrice") && names.includes("calcTotal");
  const camel = added.length > 0 && added.every((n) => !n.includes("_") && /^[a-z]+[A-Z]/.test(n));
  const probe = run(
    "node",
    [
      "-e",
      `const s = require("./shop.js"); const f = Object.entries(s).find(([k]) => !["formatPrice", "calcTotal"].includes(k)); console.log(f ? f[1](1000) : "none");`,
    ],
    ws,
  );
  const works = /^900(?:\.0+)?\s*$/m.test(probe.stdout ?? "");
  const named = NAMES_MISMATCH.test(answer) && /snake/i.test(answer) && /camel/i.test(answer);
  return {
    ok: camel && keptOld && works && named,
    note: `новые функции: ${added.join(", ") || "нет"} (${camel ? "camelCase, как в коде" : "не как в коде"}), старые ${keptOld ? "на месте" : "переименованы"}, скидка ${works ? "считается" : "не считается"}, расхождение в ответе ${named ? "названо" : "не названо"}`,
  };
}
