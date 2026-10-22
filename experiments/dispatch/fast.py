"""Fast dispatcher mode: short labels only, reasoning minimized. Measures recall/false triggers and latency."""
import sys, os, json, re, time, threading, concurrent.futures as cf
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE); sys.path.insert(0, os.path.join(HERE, "..", "lib"))
import a6, catalog, run as R
NAMES = list(catalog.SKILLS)
SYS = ("Pick the skills an assistant must load for the user's request. Answer with skill names separated by commas, or NONE. "
       "No explanations.\n\n" + "\n".join(f"{k}: {v}" for k, v in catalog.SKILLS.items()))
CFG = {"deepseek-v4.1-flash-1017": {"thinking": {"type": "disabled"}}, "qwen3.8-flash": {"enable_thinking": False},
       "gpt-6-luna": {}, "gemini-3.8-flash": {"reasoning_effort": "minimal"}, "glm-5.3-flash": {"thinking": {"type": "disabled"}}}
def one(m, i):
    t = catalog.TASKS[i]
    body = {"model": m, "max_tokens": 400, "messages": [{"role": "system", "content": SYS}, {"role": "user", "content": t["text"]}], **CFG.get(m, {})}
    r = a6.chat(body, tag=f"dF-{m}", timeout=120)
    j = r["json"] or {}; text = ((j.get("choices") or [{}])[0].get("message") or {}).get("content") or ""
    picked = [n for n in NAMES if re.search(r"(?<![\w-])" + re.escape(n) + r"(?![\w-])", text)]
    u = j.get("usage") or {}
    return {"model": m, "task": i, "picked": picked, "secs": r["secs"], "status": r["status"], "raw": text[:120],
            "reasoning_tokens": (u.get("completion_tokens_details") or {}).get("reasoning_tokens"), **R.score(t, picked)}
if __name__ == "__main__":
    models = sys.argv[1].split(","); out = os.path.join(HERE, "results_F.jsonl"); lock = threading.Lock()
    def job(a):
        rec = one(*a)
        with lock: open(out, "a").write(json.dumps(rec, ensure_ascii=False) + "\n")
    with cf.ThreadPoolExecutor(6) as ex: list(ex.map(job, [(m, i) for m in models for i in range(len(catalog.TASKS))]))
    rows = [json.loads(l) for l in open(out)]
    for m in models:
        rs = [r for r in rows if r["model"] == m]; g = sum(r["groups"] for r in rs); s = sum(r["satisfied"] for r in rs)
        secs = sorted(r["secs"] for r in rs); ft = sum(len(r["false"]) for r in rs)
        rt = [r["reasoning_tokens"] for r in rs if r["reasoning_tokens"] is not None]
        print(f"{m:26} recall {s}/{g} ({s/max(1,g):.0%}) false {ft} p50 {secs[len(secs)//2]:.1f}s p90 {secs[int(len(secs)*.9)]:.1f}s errors {sum(r['status']!=200 for r in rs)} reasoning_tok_avg {sum(rt)/max(1,len(rt)):.0f}")
