// zod в package.json — ровно последняя версия из реестра npm на момент проверки.
import { exactLatest } from "../../lib/live.mjs";

export default async function check({ ws }) {
  return exactLatest(ws, "zod");
}
