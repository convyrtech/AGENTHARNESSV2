// Расплывчатая просьба (этап 14): «сделай что-нибудь для кофейни» — модели делают, но не говорят, как поняли
// (A/B: проваливали и pi, и prsloy, и Opus; ответ 61–88 знаков, допущение не названо). Промпт просит строку
// «Понял так: … Если иначе — скажи.»; здесь — подпорка кодом, узкая, чтобы не было ложных срабатываний:
//   - в сообщении пользователя явный признак расплывчатости («что-нибудь», «на твой вкус», «придумай», «сам
//     реши»…); «что-то» не берём — «что-то сломалось» это обычная просьба починить;
//   - ход что-то сделал (edit/write);
//   - в финальном ответе нет названного прочтения («понял», «исходил», «решил», «если иначе»…).
// Тогда один раз за сообщение: «допиши одной строкой, как понял». Код больше ничего не трогает.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { recordEvent } from "./learning-log.ts";
import type { ResolvedOptions } from "./options.ts";

export const VAGUE_MARKERS =
  /(?<!\p{L})(?:что-нибудь|чего-нибудь|какой-нибудь|какую-нибудь|какое-нибудь|какие-нибудь|на (?:твой|ваш|свой) вкус|придумай|придумайте|сам(?:а)? (?:реши|выбери|придумай)|по своему усмотрению|без разницы что)(?!\p{L})/iu;

export const READING_NAMED =
  /понял(?:а)?(?:\s+так|,)|я понял|исходил(?:а)?|предполож|допущ|допустил|решил(?:а)?,? что|выбрал(?:а)?|сделал(?:а)? так|если (?:нужно |хотите |надо )?(?:иначе|другое|по-другому)/iu;

export const VAGUE_NUDGE =
  "Просьба была расплывчатой, а в ответе не сказано, как ты её понял. Допиши к ответу одну строку: «Понял так: <что сделал и что придумал сам>. Если иначе — скажи.» Больше ничего не меняй.";

type Part = { type: string; text?: string };

export function installVagueRequest(pi: ExtensionAPI, opts: ResolvedOptions): void {
  if (opts.profile !== "code") return;
  let vague = false;
  let edited = false;
  let nudged = false;
  let last: { stopReason: string | undefined; content: Part[] } | undefined;

  pi.on("before_agent_start", (event) => {
    if (event.messageType !== "user") return;
    vague = VAGUE_MARKERS.test(event.prompt);
    edited = false;
    nudged = false;
    last = undefined;
  });

  pi.on("tool_result", (event) => {
    if ((event.toolName === "edit" || event.toolName === "write") && !event.isError) edited = true;
    return undefined;
  });

  pi.on("message_end", (event) => {
    const m = event.message as { role: string; stopReason?: string; content?: unknown };
    if (m.role === "assistant" && Array.isArray(m.content))
      last = { stopReason: m.stopReason, content: m.content as Part[] };
  });

  pi.on("agent_before_settle", (event, ctx) => {
    // Гейт или другая проверка уже вернули модель к работе — сначала пусть доделает.
    if (event.outcome !== "completed" || event.continue || !vague || !edited || nudged || !last)
      return undefined;
    if (last.stopReason !== "stop" || last.content.some((p) => p.type === "toolCall"))
      return undefined;
    const text = last.content.map((p) => (p.type === "text" ? (p.text ?? "") : "")).join("\n");
    if (!text.trim() || READING_NAMED.test(text)) return undefined;
    nudged = true;
    recordEvent(ctx, { kind: "vague.nudge" });
    return {
      entries: [
        ...event.entries,
        {
          type: "custom_message",
          customType: "prsloy-harness",
          content: VAGUE_NUDGE,
          display: false,
        },
      ],
      continue: true,
    };
  });
}
