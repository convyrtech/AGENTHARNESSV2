"""A0: billing/usage integrity and hidden prompt injection. Same tiny prompt, 3 repeats per model."""
import sys, json; sys.path.insert(0, 'lib'); import a6
MODELS = ["deepseek-v4.1-flash-1017", "glm-5.3", "kimi-k3", "qwen3.8-max", "minimax-m3",
          "claude-opus-5-5", "gemini-4-argon", "gpt-6.1-sol"]
PROMPT = "Reply with the single word: pong"
rows = []
u0 = a6.usage_cents()
for m in MODELS:
    for i in range(3):
        r = a6.chat({"model": m, "messages": [{"role": "user", "content": PROMPT}], "max_tokens": 300}, tag=f"a0-{m}")
        j = r["json"] or {}
        u = j.get("usage") or {}
        msg = ((j.get("choices") or [{}])[0].get("message") or {})
        rows.append({"model": m, "try": i, "status": r["status"], "secs": r["secs"],
                     "resp_model": j.get("model"), "provider": j.get("provider"),
                     "prompt_tokens": u.get("prompt_tokens"), "completion_tokens": u.get("completion_tokens"),
                     "reasoning_tokens": (u.get("completion_tokens_details") or {}).get("reasoning_tokens"),
                     "cached": (u.get("prompt_tokens_details") or {}).get("cached_tokens"),
                     "content": (msg.get("content") or "")[:60], "has_reasoning": bool(msg.get("reasoning_content")),
                     "err": None if r["status"] == 200 else (r["raw"] or "")[:200]})
        print(json.dumps(rows[-1], ensure_ascii=False))
print("usage cents", u0, "->", a6.usage_cents())
json.dump(rows, open("results_a0.json", "w"), ensure_ascii=False, indent=1)
