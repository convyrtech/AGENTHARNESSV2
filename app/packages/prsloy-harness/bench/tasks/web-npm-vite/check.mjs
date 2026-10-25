// vite: ^<последний мажор>.x.y, не выше последней версии.
import { latestMajorRange } from "../../lib/live.mjs";

export default async function check({ ws }) {
  return latestMajorRange(ws, "vite");
}
