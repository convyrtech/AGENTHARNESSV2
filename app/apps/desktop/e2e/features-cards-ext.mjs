// e2e only: a Pi extension in the test's agent folder that shows the harness's cards on demand.
// The fake model calls `emit_card` with the card's customType, text and details; the card goes
// through the real host and timeline exactly as the harness's own cards do (showCard).
export default function register(pi) {
  pi.registerTool({
    name: "emit_card",
    label: "emit card",
    description: "Show a harness card (e2e).",
    parameters: {
      type: "object",
      properties: {
        customType: { type: "string" },
        content: { type: "string" },
        details: { type: "object" },
      },
      required: ["customType", "content"],
    },
    async execute(_id, params) {
      await pi.sendMessage(
        {
          customType: params.customType,
          content: params.content,
          display: true,
          details: params.details,
        },
        { triggerTurn: false },
      );
      return { content: [{ type: "text", text: "card shown" }], details: undefined };
    },
  });
}
