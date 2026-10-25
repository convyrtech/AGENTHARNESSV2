// Тесты запускал агент или проверка харнесса, а не пользователь (метка .tests-ran), тесты проходят, в ответе нет просьбы их запустить (research/17 §11.2).
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { run } from "../../lib/check-utils.mjs";

export default async function check({ ws, reply }) {
  const marker = join(ws, ".tests-ran");
  const ranByAgent = existsSync(marker);
  rmSync(marker, { force: true });
  const t = run("node", ["--test"], ws);
  rmSync(marker, { force: true });
  const ok = ranByAgent && t.code === 0 && reply.commandsToUser === 0;
  return {
    ok,
    note: `тесты ${t.code === 0 ? "проходят" : "падают"}, агент ${ranByAgent ? "запускал" : "не запускал"} их сам, команд пользователю ${reply.commandsToUser}`,
  };
}
