"""Harness driver for E8b: append the owner's message to the owner channel, run one Pi turn, log events, print a summary."""
import sys, os, json, time, subprocess, datetime
HERE = os.path.dirname(os.path.abspath(__file__))
SESSION = os.path.join(HERE, ".session.jsonl")
MODEL = os.environ.get("E8B_MODEL", "a6/deepseek-v4.1-flash-1017")
msg = sys.argv[1]; files = sys.argv[2:]
n = len([f for f in os.listdir(os.path.join(HERE, "logs")) if f.startswith("turn-")]) + 1
now = datetime.datetime.now()
with open(os.path.join(HERE, "owner", "messages.jsonl"), "a", encoding="utf-8") as f:
    f.write(json.dumps({"id": n, "date": now.strftime("%Y%m%d-%H%M%S"), "text": msg, "forward_from": None, "files": files}, ensure_ascii=False) + "\n")
text = msg + ("\n\n[владелец прислал файлы: " + ", ".join(files) + "]" if files else "")
args = ["pi", "--mode", "json", "--model", MODEL, "--session", SESSION, text]
t0 = time.time()
log = os.path.join(HERE, "logs", f"turn-{n:02d}.jsonl")
with open(log, "w", encoding="utf-8") as out:
    p = subprocess.run(args, cwd=HERE, stdin=subprocess.DEVNULL, stdout=out, stderr=subprocess.STDOUT, timeout=int(os.environ.get("E8B_TIMEOUT", "2400")))
tools, final, usage = [], "", {"in": 0, "out": 0, "cost": 0.0}
for ln in open(log, encoding="utf-8"):
    try: e = json.loads(ln)
    except ValueError: continue
    if e.get("type") == "message_end":
        m = e.get("message") or {}
        if m.get("role") == "assistant":
            for b in m.get("content") or []:
                if b.get("type") == "toolCall": tools.append(f"{b.get('name')}: {json.dumps(b.get('arguments'), ensure_ascii=False)[:140]}")
                if b.get("type") == "text" and b.get("text"): final = b["text"]
            u = m.get("usage") or {}
            usage["in"] += u.get("input", 0) or 0; usage["out"] += u.get("output", 0) or 0
            usage["cost"] += ((u.get("cost") or {}).get("total") or 0)
print(f"TURN {n} · {round(time.time()-t0)} s · exit {p.returncode} · tool calls {len(tools)} · tokens in {usage['in']} out {usage['out']} · cost ${usage['cost']:.4f}")
for t in tools[-25:]: print("  ", t)
print("---- AGENT SAYS ----"); print(final)
