"""Vision bench for the 'design picker' role: OCR 9 items + pairwise choice in both orders (agreement with owner: 2>1>3)."""
import sys, os, json, itertools, concurrent.futures as cf
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import pick2 as P, diag as D
from lib import a6
NEW = {"deepseek1017": ("deepseek-v4.1-flash-1017", {}), "gemini38flash": ("gemini-3.8-flash", {}), "kimik3": ("kimi-k3", {}),
       "qwen38max": ("qwen3.8-max", {}), "minimaxm3": ("minimax-m3", {}), "luna": ("gpt-6-luna", {})}
P.MODELS.update(NEW); D.P.MODELS.update(NEW)
def probe(i):
    body = {"model": "claude-opus-5-5", "max_tokens": 4000, "reasoning_effort": "high", "stream_options": {"include_usage": True},
            "messages": [{"role": "user", "content": "Одной строкой: как тебя зовут и в каком продукте или IDE ты сейчас работаешь (по твоим инструкциям)?"}]}
    r = a6.chat_stream(body, tag=f"probe-{i}", timeout=300)
    ch = [c for c in r["chunks"] if isinstance(c, dict)]
    t = "".join(((c.get("choices") or [{}])[0].get("delta") or {}).get("content") or "" for c in ch)
    u = [c["usage"] for c in ch if c.get("usage")]
    return {"probe": i, "prompt_tokens": u[-1].get("prompt_tokens") if u else None, "answer": t.strip()[:160]}
if __name__ == "__main__":
    owner_better = {("2", "1"), ("2", "3"), ("1", "3")}
    with cf.ThreadPoolExecutor(12) as ex:
        probes = list(ex.map(probe, range(4)))
        ocr = list(ex.map(D.ocr, NEW))
        pw = list(ex.map(lambda j: P.judge(*j), [(m, a, b) for m in NEW for a, b in itertools.permutations("123", 2)]))
    for x in probes: print(json.dumps(x, ensure_ascii=False))
    for o in ocr:
        rs = [r for r in pw if r["model"] == o["model"]]
        agree = sum(1 for r in rs if r["winner"] and (r["winner"], r["y"] if r["winner"] == r["x"] else r["x"]) in owner_better)
        consist = sum(1 for a, b in itertools.combinations("123", 2)
                      if (x := next((r["winner"] for r in rs if (r["x"], r["y"]) == (a, b)), None)) and x == next((r["winner"] for r in rs if (r["x"], r["y"]) == (b, a)), None))
        print(f"{o['model']:14s} OCR {o['ocr_exact']} | agree {agree}/6 | consistent {consist}/3 | no-answer {sum(r['winner'] is None for r in rs)} | switch {o.get('switch')}")
    json.dump({"probes": probes, "ocr": ocr, "pairwise": pw}, open(os.path.join(P.HERE, "vision-bench.json"), "w"), ensure_ascii=False, indent=1)
