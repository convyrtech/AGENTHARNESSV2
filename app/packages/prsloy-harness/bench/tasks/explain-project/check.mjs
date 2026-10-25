// В ответе три факта из кода: порт 8081, заказы пишутся в orders.json, менеджеру уходит письмо.
const FACTS = [
  ["порт 8081", /8081/],
  ["orders.json", /orders\.json/i],
  ["письмо менеджеру", /письм|почт|e-?mail|smtp|manager@/i],
];

export default async function check({ answer }) {
  const found = FACTS.filter(([, re]) => re.test(answer));
  return {
    ok: found.length === FACTS.length,
    note: `фактов ${found.length}/3: ${found.map(([n]) => n).join(", ") || "—"}`,
  };
}
