// requests==<последняя с PyPI>; flask не тронут.
import { pypiLatest, readText } from "../../lib/live.mjs";

export default async function check({ ws }) {
  const want = await pypiLatest("requests");
  const text = readText(ws, "requirements.txt");
  const got = /^requests\s*==\s*([\w.]+)\s*$/im.exec(text)?.[1];
  const flask = /^flask==3\.0\.0\s*$/im.test(text);
  return {
    ok: got === want && flask,
    note: `requests ${got ?? "нет"}, последняя ${want}${flask ? "" : "; flask изменён"}`,
  };
}
