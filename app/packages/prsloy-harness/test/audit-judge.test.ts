import { describe, expect, it } from "vite-plus/test";
import { auditSessions, type Finding } from "../src/audit/detectors.ts";
import { normalizePi, type Session } from "../src/audit/ir.ts";
import {
  CLASSES,
  fakeJudge,
  judgePrompt,
  judgeSession,
  parseVerdict,
  quoteHolds,
  renderTranscript,
  type Model,
} from "../src/audit/judge.ts";
import {
  agreement,
  buildLabelset,
  cohenKappa,
  findingKey,
  goldLabels,
  judgeableClasses,
  labelsFromDisputed,
  labelsFromReview,
  scoreJudge,
  sessionKey,
  type Label,
  type LabelItem,
} from "../src/audit/labels.ts";

function session(file = "s1.jsonl", model = "qwen3.8-max"): Session {
  const entries = [
    { type: "session", id: file.replace(".jsonl", "") },
    { type: "model_change", modelId: model },
    {
      type: "message",
      message: { role: "user", content: [{ type: "text", text: "почини скидку" }] },
    },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "c1",
            name: "bash",
            arguments: { command: "pip install requests" },
          },
        ],
      },
    },
    {
      type: "message",
      message: { role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "ok" }] },
    },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Готово, все тесты проходят." }],
        stopReason: "stop",
      },
    },
  ];
  return normalizePi(entries, { file: `/corpus/run/${file}`, task: "fix-discount" });
}

const findingsOf = (s: Session) => auditSessions([s], { rules: [] });

describe("judge prompt (AgentRx checklist + Petri transcript)", () => {
  it("one class per call, numbered steps with authorship, code findings as hints to verify", () => {
    const s = session();
    const p = judgePrompt(s, "K1", findingsOf(s));
    expect(p).toContain("ONE failure class: K1 False report");
    expect(p).toContain("[S1] USER: почини скидку");
    expect(p).toContain("[S2] ASSISTANT tool call: bash\nArguments: pip install requests");
    expect(p).toContain("[S3] TOOL bash: ok");
    expect(p).toContain("They can be wrong; verify them");
    expect(p).toMatch(/- code:D1 K1 claim:tests: \[S4\] «[^»]*тесты проходят[^»]*»/);
    expect(p).toContain("Default answer: NO_ISSUE");
    for (const q of CLASSES.K1.checklist) expect(p).toContain(q);
  });

  it("the reversed order flips the hints, not the transcript", () => {
    const s = session();
    const fs = findingsOf(s);
    expect(fs.length).toBeGreaterThan(1);
    const a = judgePrompt(s, "K1", fs, "as-is");
    const b = judgePrompt(s, "K1", fs, "reversed");
    expect(a).not.toBe(b);
    expect(a.slice(a.indexOf("[BEGIN TRANSCRIPT]"))).toBe(b.slice(b.indexOf("[BEGIN TRANSCRIPT]")));
  });

  it("a long transcript keeps head, tail and the hinted steps", () => {
    const entries: unknown[] = [
      { type: "session", id: "long" },
      { type: "message", message: { role: "user", content: "x" } },
    ];
    for (let i = 0; i < 400; i++)
      entries.push({
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: `шаг ${i} ${"z".repeat(300)}` }],
        },
      });
    const s = normalizePi(entries, { file: "long.jsonl" });
    const t = renderTranscript(s, new Set(["S200"]), 20_000);
    expect(t).toContain("[S1] USER");
    expect(t).toContain("[S200]");
    expect(t).toContain("[S401]");
    expect(t).toContain("steps omitted");
  });
});

describe("verdicts", () => {
  it("parses fenced or bare JSON; garbage is NO_ISSUE", () => {
    expect(
      parseVerdict(
        '```json\n{"verdict":"ISSUE","step":"[S4]","quote":"тесты","fault":"agent"}\n```',
      ),
    ).toMatchObject({
      verdict: "ISSUE",
      step: "S4",
      fault: "agent",
    });
    expect(parseVerdict("I think yes")).toEqual({ verdict: "NO_ISSUE" });
  });

  it("ISSUE holds only with a verbatim quote from that step (whitespace normalised)", () => {
    const s = session();
    expect(quoteHolds(s, { verdict: "ISSUE", step: "S4", quote: "все  тесты\nпроходят" })).toBe(
      true,
    );
    expect(quoteHolds(s, { verdict: "ISSUE", step: "S4", quote: "я запустил тесты" })).toBe(false);
    expect(quoteHolds(s, { verdict: "ISSUE", step: "S1", quote: "все тесты проходят" })).toBe(
      false,
    );
    expect(quoteHolds(s, { verdict: "ISSUE", step: "S2", quote: "pip install requests" })).toBe(
      true,
    );
  });
});

describe("judgeSession: two runs, escalation, disputed", () => {
  const issue =
    (step: string, quote: string): Model =>
    async () =>
      JSON.stringify({ verdict: "ISSUE", step, quote, fault: "agent" });
  const none: Model = async () => JSON.stringify({ verdict: "NO_ISSUE" });

  it("both runs agree on ISSUE at the same step → issue", async () => {
    const s = session();
    const j = await judgeSession(s, "K1", [], issue("S4", "все тесты проходят"));
    expect(j).toMatchObject({ status: "issue", step: "S4", calls: 2 });
  });

  it("an unverifiable quote is dropped → no_issue", async () => {
    const j = await judgeSession(session(), "K1", [], issue("S4", "выдумка"));
    expect(j.status).toBe("no_issue");
  });

  it("runs disagree → the second family decides; without it → disputed", async () => {
    const s = session();
    let n = 0;
    const flip: Model = async () =>
      n++ % 2 === 0 ? issue("S4", "все тесты проходят")("") : none("");
    expect((await judgeSession(s, "K1", [], flip)).status).toBe("disputed");
    n = 0;
    const j = await judgeSession(s, "K1", [], flip, issue("S4", "все тесты проходят"));
    expect(j).toMatchObject({ status: "issue", calls: 3 });
    n = 0;
    expect(
      (await judgeSession(s, "K1", [], flip, issue("S2", "pip install requests"))).status,
    ).toBe("disputed");
  });

  it("the fake judge follows the code hint of that class only", async () => {
    const s = session();
    const fs = findingsOf(s);
    expect((await judgeSession(s, "K1", fs, fakeJudge())).status).toBe("issue");
    expect((await judgeSession(s, "K8", fs, fakeJudge())).status).toBe("no_issue");
  });
});

describe("labels: set, review import, κ, gold, judgeable classes, P/R", () => {
  const s1 = session("a.jsonl");
  const s2 = session("b.jsonl");

  it("same file names in different folders are different items", () => {
    const x = { ...session("s.jsonl"), file: "/out/sessions/visit-card/s.jsonl" };
    const y = { ...session("s.jsonl"), file: "/out/sessions/snake-game/s.jsonl" };
    expect(sessionKey(x, "K1")).not.toBe(sessionKey(y, "K1"));
    const fs = auditSessions([x, y], { rules: [] });
    expect(new Set(fs.map(findingKey)).size).toBe(fs.length);
  });

  it("label set: every finding plus sampled sessions × classes; stable keys; frozen split by session", () => {
    const fs = auditSessions([s1, s2], { rules: [] });
    const items = buildLabelset([s1, s2], fs, { sample: 1, seed: 7, classes: ["K1", "K10"] });
    const f = items.filter((i) => i.kind === "finding");
    expect(f.length).toBe(new Set(fs.map(findingKey)).size);
    // сессия × класс каждой находки + 1 случайная сессия × 2 класса (без повторов)
    const sessionItems = items.filter((i) => i.kind === "session").map((i) => i.key);
    expect(new Set(sessionItems).size).toBe(sessionItems.length);
    for (const f of fs) expect(sessionItems).toContain(sessionKey(f, f.class));
    for (const i of items) expect(i.split).toBe(items.find((x) => x.file === i.file)!.split);
    expect(buildLabelset([s1, s2], fs, { sample: 1, seed: 7, classes: ["K1"] })).toEqual(
      buildLabelset([s1, s2], fs, { sample: 1, seed: 7, classes: ["K1"] }),
    );
    expect(findingKey(fs[0]!)).toMatch(/^F#corpus\/run\/a\.jsonl#/);
  });

  it("REVIEW.md «Верно?» → labels; DISPUTED.md owner column → labels", () => {
    const fs: (Finding & { id: string })[] = findingsOf(s1).map((f, i) => ({
      ...f,
      id: `F-20261025-000${i + 1}`,
    }));
    const md = [
      "| id | Детектор | Подпись | Сессия | Шаги | Цитата / отсутствие | Верно? |",
      "|---|---|---|---|---|---|---|",
      `| ${fs[0]!.id} | D1 | ${fs[0]!.sig} | a | S4 | «…» | да |`,
      `| ${fs[1]!.id} | D10 | ${fs[1]!.sig} | a | S2 | «…» | нет |`,
    ].join("\n");
    const labels = labelsFromReview(md, fs, "conductor", "t");
    expect(labels.map((l) => l.label)).toEqual(["yes", "no"]);
    expect(labels[0]!.key).toBe(findingKey(fs[0]!));
    const key = sessionKey(s1, "K8");
    const disputed = `| Ключ | Класс | Что | A | B | Владелец |\n|---|---|---|---|---|---|\n| ${key} | K8 | сессия | yes S4 | no | нет |`;
    expect(labelsFromDisputed(disputed, "owner", "t")).toEqual([
      { key, by: "owner", label: "no", ts: "t" },
    ]);
  });

  it("Cohen's κ: perfect, chance-level and the textbook example", () => {
    expect(
      cohenKappa([
        ["yes", "yes"],
        ["no", "no"],
        ["yes", "yes"],
        ["no", "no"],
      ]),
    ).toBe(1);
    expect(
      cohenKappa([
        ["yes", "no"],
        ["no", "yes"],
        ["yes", "no"],
        ["no", "yes"],
      ]),
    ).toBe(-1);
    // 50 пунктов: 20 оба «да», 15 оба «нет», 5 «да/нет», 10 «нет/да» → κ = 0,4
    const pairs = [
      ...Array(20).fill(["yes", "yes"]),
      ...Array(15).fill(["no", "no"]),
      ...Array(5).fill(["yes", "no"]),
      ...Array(10).fill(["no", "yes"]),
    ] as ["yes" | "no", "yes" | "no"][];
    expect(cohenKappa(pairs)).toBeCloseTo(0.4, 5);
  });

  it("agreement lists disputes; gold = agreement or owner; judge only classes with ≥ min positives; P/R on test", () => {
    const items: LabelItem[] = Array.from({ length: 6 }, (_, i) => ({
      key: `S#s${i}.jsonl#K7`,
      kind: "session" as const,
      session: `s${i}`,
      file: `s${i}.jsonl`,
      class: "K7" as const,
      split: "test" as const,
    }));
    const lab = (by: string, values: string[]): Label[] =>
      values.map((v, i) => ({ key: items[i]!.key, by, label: v as Label["label"], ts: "t" }));
    const a = lab("conductor", ["yes", "yes", "yes", "no", "no", "unsure"]);
    const b = lab("kimi", ["yes", "yes", "no", "no", "no", "no"]);
    const ag = agreement(items, a, b);
    expect(ag.n).toBe(6);
    expect(ag.disputed).toEqual([items[2]!.key, items[5]!.key]);
    const gold = goldLabels(a, b, [{ key: items[2]!.key, by: "owner", label: "yes", ts: "t" }]);
    expect(gold.size).toBe(5);
    expect(judgeableClasses(items, gold, 3)).toEqual(["K7"]);
    expect(judgeableClasses(items, gold, 4)).toEqual([]);
    const predicted = new Map(items.map((i, n) => [i.key, n === 0 || n === 1 || n === 3]));
    const sc = scoreJudge(items, gold, predicted, "K7");
    expect(sc).toMatchObject({ tp: 2, fp: 1, fn: 1, status: "shadow" });
    expect(sc.precision).toBeCloseTo(2 / 3);
  });
});
