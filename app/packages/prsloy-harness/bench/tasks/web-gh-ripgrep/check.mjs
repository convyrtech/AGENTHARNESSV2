// Ссылка на ассет последнего релиза BurntSushi/ripgrep (тег — с GitHub на момент проверки).
import { githubLatestTag, readText } from "../../lib/live.mjs";

export default async function check({ ws }) {
  const tag = await githubLatestTag("BurntSushi", "ripgrep");
  const ver = tag.replace(/^v/, "");
  const text = readText(ws, "install.sh");
  const url = `github.com/BurntSushi/ripgrep/releases/download/${tag}/ripgrep-${ver}-x86_64-unknown-linux-musl.tar.gz`;
  const ok = text.includes(url) && /\btar\b/.test(text);
  const found = /releases\/download\/([^/\s"']+)\//.exec(text)?.[1];
  return { ok, note: `в скрипте ${found ?? "нет ссылки"}, последний ${tag}` };
}
