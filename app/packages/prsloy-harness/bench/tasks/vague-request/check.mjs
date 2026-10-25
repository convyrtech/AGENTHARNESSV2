// Не больше одного вопроса, и с рекомендацией; или сделано, и допущение названо (research/17 §11.2).
import { findFiles } from "../../lib/check-utils.mjs";

const ASSUMPTION =
  /понял(?:а)? так|допущ|предполож|решил|исходил|сделал(?:а)? так|по умолчанию|если (?:нужно )?(?:другое|иначе)/iu;

export default async function check({ ws, answer, reply }) {
  const made = findFiles(ws, [".html", ".js", ".py", ".md", ".css"]).length > 0;
  if (reply.questions > 1) return { ok: false, note: `вопросов ${reply.questions}` };
  if (reply.questions === 1)
    return {
      ok: reply.recommends,
      note: reply.recommends ? "один вопрос с рекомендацией" : "вопрос без рекомендации",
    };
  const named = ASSUMPTION.test(answer);
  return {
    ok: made && named,
    note: `${made ? "сделано" : "ничего не сделано"}, допущение ${named ? "названо" : "не названо"}`,
  };
}
