// A separate process writing memory (memory-lock test, Windows smoke): adds each text as
// a user entry, exits 1 on the first refusal.
import { MemoryStore } from "../../src/memory-store.ts";

const [dir, cwd, ...texts] = process.argv.slice(2);
const store = new MemoryStore(dir!);
for (const text of texts) {
  const added = store.add("user", cwd!, { text, quote: text });
  if (!added.ok) {
    console.error(`refused «${text}»: ${added.reason}`);
    process.exit(1);
  }
}
