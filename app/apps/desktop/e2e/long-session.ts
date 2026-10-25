/** A generated pi session of N turns: prompt, bash call with ~4 KB output, ~1 KB reply. */
export function longSessionJsonl(cwd: string, TURNS: number): string {
  const lines: string[] = [];
  const t0 = Date.parse("2026-10-20T10:00:00Z");
  lines.push(JSON.stringify({ type: "session", version: 3, id: "long-chat", timestamp: new Date(t0).toISOString(), cwd }));
  let parent: string | null = null;
  let n = 0;
  const push = (message: Record<string, unknown>, at: number) => {
    const id = `e${++n}`;
    lines.push(JSON.stringify({ type: "message", id, parentId: parent, timestamp: new Date(at).toISOString(), message: { ...message, timestamp: at } }));
    parent = id;
  };
  const usage = { input: 1200, output: 300, cacheRead: 9000, cacheWrite: 0, totalTokens: 10500, cost: { input: 0.001, output: 0.001, cacheRead: 0.0001, cacheWrite: 0, total: 0.0021 } };
  const assistant = { role: "assistant", api: "openai-completions", provider: "zeno-fake", model: "zeno-fake", usage };
  const output = Array.from({ length: 80 }, (_, i) => `drwxr-xr-x  user  staff  4096  file-${i}.txt  строка вывода номер ${i}`).join("\n");
  for (let turn = 1; turn <= TURNS; turn++) {
    const at = t0 + turn * 60_000;
    push({ role: "user", content: `Ход ${turn}: покажи файлы и объясни` }, at);
    push({ ...assistant, stopReason: "toolUse", content: [{ type: "text", text: "Смотрю файлы." }, { type: "toolCall", id: `call-${turn}`, name: "bash", arguments: { command: `ls -la dir-${turn}` } }] }, at + 1000);
    push({ role: "toolResult", toolCallId: `call-${turn}`, toolName: "bash", isError: false, content: [{ type: "text", text: `[exit 0 · 0,2 с · 4 КБ]\n${output}` }] }, at + 2000);
    const reply = "";
    push({ ...assistant, stopReason: "stop", content: [{ type: "text", text: `${reply}## Итог хода ${turn}\n\n${"Это **длинный** ответ с `кодом` и списком:\n\n- пункт один\n- пункт два\n\n".repeat(6)}` }] }, at + 3000);
  }
  return `${lines.join("\n")}\n`;
} // prettier-ignore
