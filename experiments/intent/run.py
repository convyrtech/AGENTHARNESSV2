"""Intent layer experiment. Variants:
 direct : cheap executor gets the raw request
 brief  : cheap model writes a short brief (interpretation, audience, assumptions, success criteria) -> cheap executor
 deep   : premium planner applies 'deeper not bigger' + prior-art + concrete art direction -> cheap executor
 premium: premium model does it alone (reference)
Outputs saved to out/<id>/<variant>.(html|md)."""
import sys, os, json, re, threading, concurrent.futures as cf
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE); sys.path.insert(0, os.path.join(HERE, "..", "lib"))
import a6, requests as RQ
EXEC = os.environ.get("EXEC", "deepseek-v4.1-flash-1017"); PLAN = os.environ.get("PLAN", "claude-opus-5-5")
OUT = os.path.join(HERE, "out")

DELIVER = {
 "web": ("Deliver ONE complete, self-contained HTML file (inline CSS and JS; you may load fonts and libraries from public CDNs such as "
         "cdnjs/jsdelivr/unpkg/Google Fonts). No placeholders like 'lorem ipsum' or 'image here'; use CSS/SVG/canvas visuals instead of "
         "external images. Output ONLY the HTML inside one ```html code block."),
 "text": "Deliver the final result itself (not advice about how to do it), ready to use. Write in Russian.",
}
EXEC_SYS = "You are a skilled assistant who does the work for non-technical users. The user cannot answer questions now; make sensible choices yourself."
BRIEF_SYS = ("You turn a vague request from a non-technical user into a short brief for the person who will do the work. The user cannot answer "
             "questions now. Write in Russian, max 150 words: 1) what the user most likely wants (one line), 2) who it is for, 3) 3-5 assumptions "
             "you make, each marked (допущение), 4) 3-5 concrete success criteria the result must meet.")
DEEP_SYS = ("You are a top professional planning work that a junior executor will carry out. The user is non-technical and cannot answer questions now. "
            "Make the result deeper, not bigger: keep the user's goal and scope but raise the standard. Write in Russian, max 350 words:\n"
            "1) What the user really wants and the decision/outcome it serves.\n2) What a top professional in this field would do that the user didn't ask for (2-3 moves).\n"
            "3) Proven solutions, patterns, references and tools to reuse instead of inventing (name them concretely: libraries, known site patterns, frameworks of persuasion/storytelling etc.).\n"
            "4) A concrete specification for the executor: structure/sections, style/art direction (palette, typography, motion, tone) or text structure, specific content points.\n"
            "5) Acceptance checks: what concretely must be true for the result to be excellent, and the typical failures to avoid (for texts: AI cliches).")

def chat(model, msgs, tag, max_tokens=16000):
    r = a6.chat({"model": model, "messages": msgs, "max_tokens": max_tokens}, tag=tag, timeout=900)
    j = r["json"] or {}
    return ((j.get("choices") or [{}])[0].get("message") or {}).get("content") or "", j.get("usage") or {}, r["status"]

def extract(kind, text):
    if kind == "web":
        m = re.search(r"```html\s*(.*?)```", text, re.S) or re.search(r"(<!DOCTYPE html.*</html>)", text, re.S | re.I)
        return m.group(1).strip() if m else text
    return text.strip()

def run(req, variant):
    kind = req["kind"]; uid = req["id"]; meta = {"id": uid, "variant": variant}
    if variant == "premium":
        out, u, st = chat(PLAN, [{"role": "system", "content": EXEC_SYS}, {"role": "user", "content": req["text"] + "\n\n" + DELIVER[kind]}], f"in-{uid}-premium")
        meta["usage"] = [u]
    else:
        extra = ""
        if variant == "brief":
            b, u0, _ = chat(EXEC, [{"role": "system", "content": BRIEF_SYS}, {"role": "user", "content": req["text"]}], f"in-{uid}-brief-plan", 3000)
            extra = "\n\nБриф (подготовлен заранее, следуй ему):\n" + b; meta["plan"] = b
        elif variant == "deep":
            b, u0, _ = chat(PLAN, [{"role": "system", "content": DEEP_SYS}, {"role": "user", "content": req["text"]}], f"in-{uid}-deep-plan", 4000)
            extra = "\n\nСпецификация от старшего специалиста (следуй ей):\n" + b; meta["plan"] = b
        out, u, st = chat(EXEC, [{"role": "system", "content": EXEC_SYS}, {"role": "user", "content": req["text"] + extra + "\n\n" + DELIVER[kind]}], f"in-{uid}-{variant}")
        meta["usage"] = [u]
    os.makedirs(os.path.join(OUT, uid), exist_ok=True)
    body = extract(kind, out)
    open(os.path.join(OUT, uid, f"{variant}.{'html' if kind == 'web' else 'md'}"), "w").write(body)
    if "plan" in meta: open(os.path.join(OUT, uid, f"{variant}.plan.md"), "w").write(meta["plan"])
    meta.update({"status": st, "chars": len(body)})
    return meta

if __name__ == "__main__":
    variants = os.environ.get("VARIANTS", "direct,brief,deep,premium").split(",")
    ids = os.environ.get("IDS"); reqs = [r for r in RQ.R if not ids or r["id"] in ids.split(",")]
    lock = threading.Lock(); log = os.path.join(HERE, "runs.jsonl")
    def job(a):
        m = run(*a)
        with lock: open(log, "a").write(json.dumps(m, ensure_ascii=False) + "\n"); print(m["id"], m["variant"], m["status"], m["chars"], flush=True)
    with cf.ThreadPoolExecutor(8) as ex: list(ex.map(job, [(r, v) for r in reqs for v in variants]))
