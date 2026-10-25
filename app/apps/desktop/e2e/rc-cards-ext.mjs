// e2e only (RC check): one tool call shows every new harness card in a row, so the review
// spec can look at all of them in one chat. Same path as the harness's own showCard.
export default function register(pi) {
  pi.registerTool({
    name: "emit_cards",
    label: "emit cards",
    description: "Show several harness cards (e2e).",
    parameters: {
      type: "object",
      properties: { cards: { type: "array", items: { type: "object" } } },
      required: ["cards"],
    },
    async execute(_id, params) {
      for (const card of params.cards) {
        await pi.sendMessage(
          {
            customType: card.customType,
            content: card.content,
            display: true,
            details: card.details,
          },
          { triggerTurn: false },
        );
      }
      return { content: [{ type: "text", text: "cards shown" }], details: undefined };
    },
  });
}
