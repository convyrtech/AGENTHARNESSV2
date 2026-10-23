import json, sys, glob, os
for log in sorted(glob.glob(os.path.join(os.path.dirname(os.path.abspath(__file__)), "logs", "turn-*.jsonl"))):
    calls = ins = outs = 0; cost = 0.0; t = []
    for ln in open(log, encoding="utf-8"):
        try: e = json.loads(ln)
        except ValueError: continue
        if e.get("type") == "message_end" and (e.get("message") or {}).get("role") == "assistant":
            m = e["message"]; u = m.get("usage") or {}
            ins += u.get("input", 0) or 0; outs += u.get("output", 0) or 0; cost += (u.get("cost") or {}).get("total", 0) or 0
            calls += sum(1 for b in m.get("content") or [] if b.get("type") == "toolCall")
            if m.get("timestamp"): t.append(m["timestamp"])
    dur = (max(t) - min(t)) / 1000 if len(t) > 1 and isinstance(t[0], (int, float)) else None
    print(os.path.basename(log), "tool calls", calls, "in", ins, "out", outs, f"pi-cost ${cost:.4f}", "dur", dur)
