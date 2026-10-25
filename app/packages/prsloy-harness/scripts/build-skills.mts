// Собирает skills/<имя>/* в src/skills-bundle.ts: в asar-сборке файлов рядом с модулем нет, навыки едут строками
// и при старте сессии раскладываются на диск (src/skills.ts). Запуск: node scripts/build-skills.mts
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const dir = join(root, "skills");

export function collectSkills(): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const name of readdirSync(dir).sort()) {
    const skillDir = join(dir, name);
    if (!statSync(skillDir).isDirectory()) continue;
    const files: Record<string, string> = {};
    for (const file of readdirSync(skillDir).sort())
      files[file] = readFileSync(join(skillDir, file), "utf8");
    out[name] = files;
  }
  return out;
}

export function renderBundle(skills: Record<string, Record<string, string>>): string {
  return `// Сгенерировано scripts/build-skills.mts из skills/ — не править руками.\nexport const SKILL_FILES: Record<string, Record<string, string>> = ${JSON.stringify(skills, null, 2)};\n`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  writeFileSync(join(root, "src", "skills-bundle.ts"), renderBundle(collectSkills()));
  console.log("src/skills-bundle.ts обновлён");
}
