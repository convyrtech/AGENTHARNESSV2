"""A1: multi-step tool loop through the relay; reasoning passback kept vs stripped; parallel calls."""
import sys, json, copy; sys.path.insert(0, 'lib'); import a6
FILES = {"a.txt": "alpha=17", "b.txt": "beta=25", "c.txt": "gamma=58"}
TOOLS = [{"type": "function", "function": {
    "name": "read_file", "description": "Read a text file from the workspace and return its content.",
    "parameters": {"type": "object", "properties": {"path": {"type": "string", "description": "file name"}},
                   "required": ["path"], "additionalProperties": False}}}]
SYS = "You are a careful assistant. Use the read_file tool to read files. Never guess file contents."
TASK = "Read a.txt, b.txt and c.txt (you may call the tool several times in parallel), then reply with the sum of the three numbers only."

def run(model, strip_reasoning=False, extra=None, max_steps=6):
    msgs = [{"role": "system", "content": SYS}, {"role": "user", "content": TASK}]
    trace = []
    for step in range(max_steps):
        body = {"model": model, "messages": msgs, "tools": TOOLS, "max_tokens": 4000}
        if extra: body.update(extra)
        r = a6.chat(body, tag=f"a1-{model}-{'strip' if strip_reasoning else 'keep'}-s{step}")
        j = r["json"] or {}
        if r["status"] != 200 or not j.get("choices"):
            trace.append({"step": step, "status": r["status"], "err": (r["raw"] or "")[:300]}); break
        m = j["choices"][0]["message"]; fr = j["choices"][0].get("finish_reason")
        calls = m.get("tool_calls") or []
        trace.append({"step": step, "status": 200, "finish": fr, "n_calls": len(calls),
                      "ids": [c.get("id") for c in calls], "has_reasoning": bool(m.get("reasoning_content")),
                      "reasoning_keys": [k for k in m if "reason" in k or "think" in k],
                      "content": (m.get("content") or "")[:80], "provider": j.get("provider"),
                      "usage": j.get("usage")})
        if not calls:
            break
        am = {k: v for k, v in m.items() if k in ("role", "content", "tool_calls", "reasoning_content", "reasoning")}
        if strip_reasoning:
            am.pop("reasoning_content", None); am.pop("reasoning", None)
        msgs.append(am)
        for c in calls:
            try:
                path = json.loads(c["function"]["arguments"]).get("path")
            except Exception as e:
                path = None
            msgs.append({"role": "tool", "tool_call_id": c["id"], "content": FILES.get(path, f"ERROR: no such file {path!r}")})
    return trace

MODELS = sys.argv[1:] or ["deepseek-v4.1-flash-1017", "glm-5.3", "kimi-k3", "qwen3.8-max", "minimax-m3",
                          "claude-opus-5-5", "gemini-4-argon", "gpt-6.1-sol"]
out = {}
u0 = a6.usage_cents()
for m in MODELS:
    for strip in (False, True):
        t = run(m, strip)
        out[f"{m}|{'strip' if strip else 'keep'}"] = t
        last = t[-1]
        print(m, "strip" if strip else "keep", "| steps", len(t), "| calls/step", [s.get("n_calls") for s in t],
              "| reasoning", [s.get("has_reasoning") for s in t], "| final", last.get("content") or last.get("err"),
              "| status", [s["status"] for s in t])
print("usage cents", u0, "->", a6.usage_cents())
json.dump(out, open("results_a1.json", "w"), ensure_ascii=False, indent=1)
