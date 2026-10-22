"""After switching the key to the guaranteed pool: who answers as Opus, per-call price vs before, do other models still work."""
import sys, os, json, time, urllib.request, concurrent.futures as cf
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from lib import a6
PROBE = "Одной строкой: как тебя зовут и в каком продукте или IDE ты сейчас работаешь (по твоим инструкциям)?"
def call(model, extra=None, tag="pool"):
    body = {"model": model, "max_tokens": 2000, "stream_options": {"include_usage": True},
            "messages": [{"role": "user", "content": PROBE}], **(extra or {})}
    try:
        r = a6.chat_stream(body, tag=f"{tag}-{model}", timeout=300)
    except Exception as e:
        return {"model": model, "extra": extra, "status": f"exc {e!r}"[:80]}
    ch = [c for c in r["chunks"] if isinstance(c, dict)]
    t = "".join(((c.get("choices") or [{}])[0].get("delta") or {}).get("content") or "" for c in ch)
    u = [c["usage"] for c in ch if c.get("usage")]; err = [c for c in ch if "_error" in c]
    return {"model": model, "extra": extra, "status": r["status"], "secs": r["secs"], "prompt_tokens": u[-1].get("prompt_tokens") if u else None,
            "answer": (t.strip() or (err[0]["_error"][:160] if err else ""))[:140]}
jobs = [("claude-opus-5-5", None)] * 3 + [("claude-opus-5-5", {"reasoning_effort": "high"})] * 3 + \
       [(m, None) for m in ["gpt-6.1-sol", "gemini-4-argon", "kimi-k3", "deepseek-v4.1-flash-1017", "gemini-3.8-flash", "qwen3.8-max", "glm-5.3", "minimax-m3"]]
t0 = time.time()
with cf.ThreadPoolExecutor(14) as ex:
    res = list(ex.map(lambda j: call(*j), jobs))
time.sleep(0) if False else None
for x in res: print(json.dumps(x, ensure_ascii=False))
json.dump({"t0": t0, "t1": time.time(), "res": res}, open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "after-pool.json"), "w"), ensure_ascii=False, indent=1)
