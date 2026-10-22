"""Dispatcher experiment.
A) self-selection: an agent with the full skill catalog in its system prompt and a load_skill tool (plus normal tools);
   we record which skills it loads within the first 2 model steps.
B) dispatcher: a dedicated cheap call returns JSON with the skills to load.
"""
import sys, os, json, time, re, threading, concurrent.futures as cf
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE); sys.path.insert(0, os.path.join(HERE, "..", "lib"))
import a6, catalog

LIST = "\n".join(f"- {k}: {v}" for k, v in catalog.SKILLS.items())
AGENT_SYS = ("You are an autonomous assistant inside a desktop app. You can write and run code, browse, and work with files and services.\n"
             "Skills extend what you can do. A skill contains detailed instructions; load it with the load_skill tool before doing work "
             "that the skill covers.\n\nAvailable skills:\n" + LIST)
def fn(name, desc, props, req):
    return {"type": "function", "function": {"name": name, "description": desc,
            "parameters": {"type": "object", "properties": props, "required": req, "additionalProperties": False}}}
AGENT_TOOLS = [
    fn("load_skill", "Load the full instructions of a skill by name.", {"name": {"type": "string"}}, ["name"]),
    fn("bash", "Run a shell command.", {"command": {"type": "string"}}, ["command"]),
    fn("write_file", "Write a file.", {"path": {"type": "string"}, "content": {"type": "string"}}, ["path", "content"]),
    fn("web_search", "Search the web.", {"query": {"type": "string"}}, ["query"]),
    fn("ask_user", "Ask the user a clarifying question.", {"question": {"type": "string"}}, ["question"]),
]
DISP_SYS = ("You are a dispatcher for an AI assistant. Given the user's request and the skill catalog, choose which skills the "
            "assistant must load to do an excellent job. Pick every skill that is clearly needed and nothing that is not; pick none "
            "if the request needs no skill. Reply with ONLY JSON: {\"skills\": [names], \"needs_clarification\": true|false}.\n\n"
            "Skill catalog:\n" + LIST)

def agent_select(model, task):
    msgs = [{"role": "system", "content": AGENT_SYS}, {"role": "user", "content": task["text"]}]
    picked, steps, err, usage = [], 0, None, {"p": 0, "c": 0}
    for steps in (1, 2):
        r = a6.chat({"model": model, "messages": msgs, "tools": AGENT_TOOLS, "max_tokens": 4000}, tag=f"dA-{model}", timeout=300)
        j = r["json"] or {}
        if r["status"] != 200 or not j.get("choices"):
            err = f"http {r['status']}"; break
        u = j.get("usage") or {}; usage["p"] += u.get("prompt_tokens") or 0; usage["c"] += u.get("completion_tokens") or 0
        m = j["choices"][0]["message"]; calls = m.get("tool_calls") or []
        am = {k: v for k, v in m.items() if k in ("role", "content", "tool_calls", "reasoning_content")}; am["role"] = "assistant"
        msgs.append(am)
        if not calls: break
        for c in calls:
            f = c.get("function") or {}
            try: a = json.loads(f.get("arguments") or "{}")
            except Exception: a = {}
            if f.get("name") == "load_skill":
                picked.append(str(a.get("name", "")).strip())
                res = f"Skill '{a.get('name')}' loaded. (instructions omitted in this test)"
            elif f.get("name") == "ask_user":
                res = "User: just do it, use your best judgment."
            else:
                res = "OK"
            msgs.append({"role": "tool", "tool_call_id": c.get("id"), "content": res})
    return picked, {"steps": steps, "err": err, "usage": usage}

def dispatch(model, task):
    r = a6.chat({"model": model, "max_tokens": 3000, "messages": [{"role": "system", "content": DISP_SYS}, {"role": "user", "content": task["text"]}]},
                tag=f"dB-{model}", timeout=300)
    j = r["json"] or {}
    text = ((j.get("choices") or [{}])[0].get("message") or {}).get("content") or ""
    u = j.get("usage") or {}
    m = re.search(r"\{.*\}", text, re.S); picked = []
    try: picked = json.loads(m.group(0)).get("skills", []) if m else []
    except Exception: pass
    return [str(x).strip() for x in picked], {"secs": r["secs"], "err": None if r["status"] == 200 else f"http {r['status']}",
                                             "usage": {"p": u.get("prompt_tokens") or 0, "c": u.get("completion_tokens") or 0}, "raw": text[:200]}

def score(task, picked):
    p = set(picked); scored = p - catalog.NEUTRAL if task["gold"] else p
    groups = task["gold"]; sat = sum(1 for g in groups if p & set(g))
    allowed = set(s for g in groups for s in g) | set(task["allowed"])
    false = sorted(scored - allowed); unknown = sorted(x for x in p if x not in catalog.SKILLS)
    return {"groups": len(groups), "satisfied": sat, "false": false, "n_picked": len(scored), "unknown": unknown}

if __name__ == "__main__":
    mode = sys.argv[1]; models = sys.argv[2].split(",")
    out = os.path.join(HERE, f"results_{mode}.jsonl"); lock = threading.Lock()
    def job(m, i):
        task = catalog.TASKS[i]
        picked, meta = (agent_select if mode == "A" else dispatch)(m, task)
        rec = {"mode": mode, "model": m, "task": i, "picked": picked, **score(task, picked), **meta}
        with lock: open(out, "a").write(json.dumps(rec, ensure_ascii=False) + "\n")
        return rec
    with cf.ThreadPoolExecutor(int(os.environ.get("WORKERS", "8"))) as ex:
        list(ex.map(lambda a: job(*a), [(m, i) for m in models for i in range(len(catalog.TASKS))]))
