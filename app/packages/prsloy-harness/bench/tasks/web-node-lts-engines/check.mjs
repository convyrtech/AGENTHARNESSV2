// engines.node: >=<новейшая LTS-ветка на сегодня> по endoflife.date.
import { major, newestLts, readJsonFile } from "../../lib/live.mjs";

export default async function check({ ws }) {
  const want = await newestLts("nodejs");
  const got = readJsonFile(ws, "package.json")?.engines?.node;
  return {
    ok: /^>=\s*\d+/.test(got ?? "") && major(got) === Number(want),
    note: `engines.node ${got ?? "нет"}, LTS ${want}`,
  };
}
