// pydantic==<последняя с PyPI>.
import { pypiLatest, readText } from "../../lib/live.mjs";

export default async function check({ ws }) {
  const want = await pypiLatest("pydantic");
  const got = /^pydantic\s*==\s*([\w.]+)\s*$/im.exec(readText(ws, "requirements.txt"))?.[1];
  return { ok: got === want, note: `pydantic ${got ?? "нет"}, последняя ${want}` };
}
