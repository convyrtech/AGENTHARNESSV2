// Сайт-визитка (#36): Автосервис «Гараж 77». Общие правила — bench/lib/landing-check.mjs (браузер на 390 и 1440).
import { checkLanding } from "../../lib/landing-check.mjs";

export default async function check({ ws, params = {} }) {
  return checkLanding(ws, params.brief ?? "", params.must ?? []);
}
