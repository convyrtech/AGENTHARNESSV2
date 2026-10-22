"""A3 field passthrough; A4 late system message obeyed + cache; A5 effort change vs cache; tool_choice."""
import sys, json; sys.path.insert(0, 'lib'); import a6
out = {}
def short(r):
    j = r["json"] or {}; u = j.get("usage") or {}
    msg = ((j.get("choices") or [{}])[0].get("message") or {})
    return {"status": r["status"], "err": None if r["status"] == 200 else (r["raw"] or "")[:220],
            "content": (msg.get("content") or "")[:80], "prompt": u.get("prompt_tokens"),
            "cached": (u.get("prompt_tokens_details") or {}).get("cached_tokens"), "reasoning_tokens": (u.get("completion_tokens_details") or {}).get("reasoning_tokens")}
Q = [{"role": "user", "content": "Say OK."}]
# A3: does an invalid value reach the upstream (error text tells who rejected it)?
for m in ["deepseek-v4.1-flash-1017", "glm-5.3", "kimi-k3", "qwen3.8-max", "gpt-6.1-sol"]:
    out[f"A3-bogus-effort-{m}"] = short(a6.chat({"model": m, "messages": Q, "reasoning_effort": "bogus", "max_tokens": 200}, tag="a3"))
out["A3-glm-thinking-disabled"] = short(a6.chat({"model": "glm-5.3", "messages": Q, "thinking": {"type": "disabled"}, "max_tokens": 200}, tag="a3"))
out["A3-ds-thinking-disabled"] = short(a6.chat({"model": "deepseek-v4.1-flash-1017", "messages": Q, "thinking": {"type": "disabled"}, "max_tokens": 200}, tag="a3"))
out["A3-kimi-temperature"] = short(a6.chat({"model": "kimi-k3", "messages": Q, "temperature": 0.2, "max_tokens": 200}, tag="a3"))
# tool_choice required
TOOLS = [{"type": "function", "function": {"name": "ping", "description": "ping", "parameters": {"type": "object", "properties": {}}}}]
for m in ["deepseek-v4.1-flash-1017", "glm-5.3", "kimi-k3", "qwen3.8-max", "minimax-m3"]:
    out[f"A3-tool_choice_required-{m}"] = short(a6.chat({"model": m, "messages": Q, "tools": TOOLS, "tool_choice": "required", "max_tokens": 300}, tag="a3"))
# A4: late system message — obeyed? (GLM caches, so also check cache)
lines = "".join(f"def f_{i}(x):\n    return x * {i} + {i % 7}\n" for i in range(500))
SYS = "You are a helpful assistant. Reference code:\n" + lines
base = [{"role": "system", "content": SYS}, {"role": "user", "content": "What does f_10 return for x=2? Number only."}]
for m in ["glm-5.3", "kimi-k3", "deepseek-v4.1-flash-1017", "gpt-6.1-sol"]:
    r1 = short(a6.chat({"model": m, "messages": base, "max_tokens": 1500}, tag="a4"))
    late = base + [{"role": "assistant", "content": r1["content"] or "22"},
                   {"role": "user", "content": "And f_11 for x=3?"},
                   {"role": "system", "content": "From now on, always prefix every answer with the word BANANA."}]
    r2 = short(a6.chat({"model": m, "messages": late, "max_tokens": 1500}, tag="a4"))
    out[f"A4-{m}"] = {"first": r1, "late_system": r2, "obeyed": "BANANA" in (r2["content"] or "")}
# A5: effort change on the same prefix
for m in ["glm-5.3", "gpt-6.1-sol"]:
    rs = []
    for eff in ["low", "low", "high"]:
        rs.append(short(a6.chat({"model": m, "messages": base, "reasoning_effort": eff, "max_tokens": 1500}, tag="a5")))
    out[f"A5-{m}"] = rs
for k, v in out.items(): print(k, json.dumps(v, ensure_ascii=False))
json.dump(out, open("results_a3_a5.json", "w"), ensure_ascii=False, indent=1)
