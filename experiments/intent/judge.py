"""Blind pairwise judging of intent-layer outputs by a cross-family panel (none of the producer families: DeepSeek, Anthropic).
Each pair is judged in both orders to cancel position bias. Web results are judged from screenshots (desktop top, full, mobile)."""
import sys, os, json, re, base64, itertools, threading, concurrent.futures as cf, collections
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE); sys.path.insert(0, os.path.join(HERE, "..", "lib"))
import a6, requests as RQ
JUDGES = os.environ.get("JUDGES", "gemini-4-argon,gpt-6.1-sol,kimi-k3").split(",")
VARIANTS = ["direct", "brief", "deep", "premium"]
OUT = os.path.join(HERE, "out"); SHOTS = os.path.join(HERE, "shots")
SYS = ("You judge results produced by an AI assistant for a NON-TECHNICAL user who sent a short, vague request. Imagine you are that user. "
       "Which result would make them happier and is more useful as-is? Consider: hits the user's unstated expectations; quality and polish; "
       "for web pages: visual design quality, 'wow' factor, layout on desktop and mobile, nothing broken or empty; for texts: sounds like a real "
       "human (no AI cliches, no 'neural network' style), right tone, ready to use. Length is not a virtue by itself. "
       "Reply with ONLY JSON: {\"winner\": \"A\"|\"B\"|\"tie\", \"why\": \"one sentence\"}.")

def img(path):
    return {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + base64.b64encode(open(path, "rb").read()).decode()}}

def content_for(req, label, variant):
    if req["kind"] == "web":
        base = os.path.join(SHOTS, f"{req['id']}__{variant}")
        parts = [{"type": "text", "text": f"Result {label}: desktop first screen, desktop full page, mobile first screen."}]
        for suf in ("_top.jpg", "_full.jpg", "_mobile.jpg"):
            if os.path.exists(base + suf): parts.append(img(base + suf))
        try:
            e = json.load(open(base + "_errors.json"))
            if e.get("errors"): parts.append({"type": "text", "text": f"(Result {label} had {len(e['errors'])} JavaScript error(s) when loading.)"})
        except Exception: pass
        return parts
    text = open(os.path.join(OUT, req["id"], f"{variant}.md")).read()
    return [{"type": "text", "text": f"Result {label}:\n<<<\n{text[:12000]}\n>>>"}]

def judge(judge_model, req, a, b):
    content = [{"type": "text", "text": f"User request: «{req['text']}»"}] + content_for(req, "A", a) + content_for(req, "B", b) + \
              [{"type": "text", "text": "Which result is better for this user? JSON only."}]
    r = a6.chat({"model": judge_model, "max_tokens": 3000, "messages": [{"role": "system", "content": SYS}, {"role": "user", "content": content}]},
                tag=f"jd-{judge_model}-{req['id']}", timeout=600)
    j = r["json"] or {}
    text = ((j.get("choices") or [{}])[0].get("message") or {}).get("content") or ""
    m = re.search(r"\{.*\}", text, re.S); w = None; why = ""
    try:
        d = json.loads(m.group(0)); w = str(d.get("winner", "")).strip().upper(); why = d.get("why", "")
    except Exception: pass
    winner = {"A": a, "B": b, "TIE": "tie"}.get(w)
    return {"judge": judge_model, "id": req["id"], "a": a, "b": b, "winner": winner, "why": why[:300], "status": r["status"]}

if __name__ == "__main__":
    out = os.path.join(HERE, "judgments.jsonl"); lock = threading.Lock()
    jobs = []
    for req in RQ.R:
        avail = [v for v in VARIANTS if os.path.exists(os.path.join(OUT, req["id"], f"{v}.{'html' if req['kind'] == 'web' else 'md'}"))]
        for x, y in itertools.combinations(avail, 2):
            for jm in JUDGES:
                jobs += [(jm, req, x, y), (jm, req, y, x)]
    def run(a):
        rec = judge(*a)
        with lock: open(out, "a").write(json.dumps(rec, ensure_ascii=False) + "\n")
    with cf.ThreadPoolExecutor(int(os.environ.get("WORKERS", "8"))) as ex: list(ex.map(run, jobs))
    print("judgments", len(jobs))
