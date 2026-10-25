// FROM ubuntu:<новейшая LTS на сегодня> по endoflife.date; остальные строки на месте.
import { newestLts, readText } from "../../lib/live.mjs";

export default async function check({ ws }) {
  const want = await newestLts("ubuntu");
  const text = readText(ws, "Dockerfile");
  const got = /^FROM\s+ubuntu:([\w.]+)/im.exec(text)?.[1];
  const rest = text.includes("apt-get install -y curl") && /CMD \["bash"\]/.test(text);
  return {
    ok: got === want && rest,
    note: `ubuntu:${got ?? "нет"}, LTS ${want}${rest ? "" : "; остальное изменено"}`,
  };
}
