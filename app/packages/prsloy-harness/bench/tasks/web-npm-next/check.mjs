// next: ^<последний мажор>.
import { latestMajorRange } from "../../lib/live.mjs";

export default async function check({ ws }) {
  return latestMajorRange(ws, "next");
}
