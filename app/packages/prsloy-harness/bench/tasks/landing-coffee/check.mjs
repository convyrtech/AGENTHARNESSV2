// Сайт-визитка (#36): Кофейня «Зерно» на Садовой. Общие правила — bench/lib/landing-check.mjs (браузер на 390 и 1440).
import { checkLanding } from "../../lib/landing-check.mjs";

export default async function check({ ws, params = {} }) {
  return checkLanding(ws, params.brief ?? "", params.must ?? []);
}
