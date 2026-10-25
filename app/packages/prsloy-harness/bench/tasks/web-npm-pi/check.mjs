// Пакет вышел после обучения большинства моделей: версия — только из реестра.
import { exactLatest } from "../../lib/live.mjs";

export default async function check({ ws }) {
  return exactLatest(ws, "@earendil-works/pi-coding-agent");
}
