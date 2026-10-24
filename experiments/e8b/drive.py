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
# harness feedback from the last turn's code checks goes to the agent (not into the owner's channel)
LAST_CHECK = os.path.join(HERE, "harness", "last-check.txt")
if os.path.exists(LAST_CHECK):
    note = open(LAST_CHECK, encoding="utf-8").read().strip()
    if "FAIL" in note:
        text = "[проверка харнесса, не владелец: страницу владельцу не показывать, пока это не исправлено]\n" + note + "\n\n[сообщение владельца]\n" + text
args = ["pi", "--mode", "json", "--model", MODEL, "--session", SESSION, text]
t0 = time.time()
# harness block (code, not prompt): shims for other AI CLIs go first on PATH
HARNESS_BIN = os.path.join(HERE, ".harness-bin")
env = dict(os.environ)
if os.path.isdir(HARNESS_BIN):
    env["PATH"] = HARNESS_BIN + os.pathsep + env.get("PATH", "")
log = os.path.join(HERE, "logs", f"turn-{n:02d}.jsonl")
with open(log, "w", encoding="utf-8") as out:
    p = subprocess.run(args, cwd=HERE, env=env, stdin=subprocess.DEVNULL, stdout=out, stderr=subprocess.STDOUT, timeout=int(os.environ.get("E8B_TIMEOUT", "2400")))
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
# code checks after the turn: no raster UI, signature move present
pages = [d for d in (os.path.join(HERE, "design", x) for x in sorted(os.listdir(os.path.join(HERE, "design")))) if os.path.exists(os.path.join(d, "STATUS.md"))] if os.path.isdir(os.path.join(HERE, "design")) else []
site = os.path.join(HERE, "site")
if pages and os.path.isdir(site) and any(f.endswith(".html") for _, _, fs in os.walk(site) for f in fs):
    r = subprocess.run([sys.executable, "-I", os.path.join(HERE, "harness", "check.py"), site, pages[0]], capture_output=True, text=True)
    open(LAST_CHECK, "w", encoding="utf-8").write(r.stdout)
    print("---- HARNESS CHECK ----"); print(r.stdout.strip())
