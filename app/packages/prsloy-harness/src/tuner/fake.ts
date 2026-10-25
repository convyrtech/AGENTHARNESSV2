// Оффлайн-улучшатель (#33): фейковые редакторы, композитор и рефлектор для CI — настоящие сессии Pi с
// инструментами и границей записи, только модель отвечает сценарием. Сценарии проходят весь путь раунда:
// чтение улик, правку, ошибку валидатора и вторую попытку (INV), слияние (композитор), таблицу правок (рефлектор).
import type { ChatRequest, ScriptedReply, Script } from "../../test/scripted-openai-server.ts";
import { messageText } from "../../test/scripted-openai-server.ts";
import type { FakeScripts } from "./ppc.ts";
import type { HarnessTree } from "./tree.ts";

export const FAKE_SKILL = "finish-check";

const FAKE_SKILL_MD = (name: string) =>
  `---\nname: ${name}\ndescription: Before saying the work is done — open the result the owner will use and check it works.\n---\n\n# Before «готово»\n\n1. Open the file or page the owner will use.\n2. Check each thing they asked for is there.\n3. Say plainly what you checked and what you could not.\n`;

export const FAKE_DELTA =
  "Перед словом «готово» открой результат и проверь его так, как его откроет владелец.";

/** Номер шага: сколько ответов ассистента уже было после последнего сообщения пользователя. */
function stepOf(request: ChatRequest): { step: number; user: string } {
  const lastUser = request.messages.findLastIndex((m) => m.role === "user");
  return {
    step: request.messages.slice(lastUser + 1).filter((m) => m.role === "assistant").length,
    user: messageText(request.messages[lastUser]),
  };
}

/** Папка улик из промпта роли (`… under \`<dir>\` …`). */
function contextOf(request: ChatRequest): string {
  const first = request.messages.find((m) => m.role === "user");
  const m = /under `([^`]+)`/.exec(messageText(first));
  if (!m) throw new Error("fake: в промпте нет папки улик");
  return m[1]!;
}

const write = (path: string, content: string): ScriptedReply => ({
  toolCalls: [{ name: "write", arguments: { path, content } }],
});

const readTranscript = (request: ChatRequest, task: string): ScriptedReply => ({
  toolCalls: [
    {
      name: "read",
      arguments: {
        path: `${contextOf(request)}/tasks/${task.replace(/\//g, "-")}/base-1/transcript.md`,
      },
    },
  ],
});

export function fakeScripts(train: readonly string[]): FakeScripts {
  const task = train[0]!;
  return {
    editor: (dim, label) => (request) => {
      const { step, user } = stepOf(request);
      const fixing = user.startsWith("The harness folder does not validate");
      if (dim === "INV") {
        // Первая попытка — с ошибкой (name не совпадает с папкой): валидатор, вторая попытка.
        if (fixing) {
          return step === 0
            ? write(`skills/${FAKE_SKILL}/SKILL.md`, FAKE_SKILL_MD(FAKE_SKILL))
            : {
                text: `<notes>\nskills/${FAKE_SKILL}/SKILL.md: name fixed to the folder name\n</notes>`,
              };
        }
        if (step === 0) return readTranscript(request, task);
        if (step === 1) return write(`skills/${FAKE_SKILL}/SKILL.md`, FAKE_SKILL_MD("finish"));
        return {
          text: `<notes>\nskills/${FAKE_SKILL}/SKILL.md: new skill — check the result before «done» (${task}, base-1)\n</notes>`,
        };
      }
      if (step === 0) return readTranscript(request, task);
      if (step === 1) return write("model-delta.md", FAKE_DELTA);
      return {
        text: `<notes>\nmodel-delta.md: one line on checking the result (${label}, ${task})\n</notes>`,
      };
    },
    composer: (base: HarnessTree, candidates: Readonly<Record<string, HarnessTree>>) => {
      const changed: [string, string][] = [];
      for (const tree of Object.values(candidates)) {
        for (const [path, text] of Object.entries(tree)) {
          if (base[path] !== text && !changed.some(([p]) => p === path)) changed.push([path, text]);
        }
      }
      return (request) => {
        const { step } = stepOf(request);
        const next = changed[step];
        if (next) return write(next[0], next[1]);
        return {
          text: `<notes>\n${changed.map(([p]) => `kept -> ${p} -> the candidate rollout on ${task}`).join("\n") || "KEEP_BASE"}\n</notes>`,
        };
      };
    },
    reflector: ((request) => {
      const { step } = stepOf(request);
      if (step === 0) return readTranscript(request, task);
      return {
        text: [
          "<edits>",
          `component: skills/${FAKE_SKILL}/SKILL.md`,
          "candidates: INV-1, composed",
          "change: new on-demand skill: check the result before «done»",
          "observed: one rollout per candidate; no execution isolates it",
          "verdict: confounded",
          "</edits>",
          "",
          "NO_ENTRY",
        ].join("\n"),
      };
    }) satisfies Script,
  };
}
