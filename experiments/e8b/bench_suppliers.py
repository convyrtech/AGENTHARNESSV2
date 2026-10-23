"""Supplier bench for the agent-loop role: same ~40K-token prefix sent N times per model (like an agent re-sending
its context), streamed. Client side: time to first token, total time, cached tokens from usage. Then a6 logs give
the supplier, its price and what was billed. Cache matters more than the list price: an agent loop re-sends
everything every call (E8b: same model, 100x price spread)."""
import sys, os, json, time, threading, urllib.request
HERE = os.path.dirname(os.path.abspath(__file__))
key = open(os.path.join(os.path.dirname(HERE), ".a6key")).read().strip()
MODELS = sys.argv[1].split(",") if len(sys.argv) > 1 else ["deepseek-v4.1-flash-1017", "gpt-6.1-sol", "kimi-k3", "claude-opus-5-5"]
N = int(sys.argv[2]) if len(sys.argv) > 2 else 8
OUT = os.path.join(HERE, "bench", time.strftime("suppliers-%Y%m%d-%H%M"))
os.makedirs(OUT, exist_ok=True)

# realistic agent context: the pipeline rules and its main tool, as an agent would have read them
src = ["/home/user/e8b-ds/design-pipeline/AGENTS.md", "/home/user/e8b-ds/design-pipeline/tools/flow.py"]
prefix = "\n\n".join(open(p, encoding="utf-8").read() for p in src)[:150000]
QUESTIONS = ["Какой шаг идёт после «2a»? Одно предложение.", "Что проверяет ворота 3? Одно предложение.",
             "Сколько вопросов владельцу можно задать на шаге 0a? Одно предложение.",
             "Что делает born()? Одно предложение.", "Какие движки нужны гейту? Одно предложение.",
             "Где лежит канал владельца? Одно предложение.", "Что значит дефолт FAIL у судьи? Одно предложение.",
             "Какой файл у шага 5s? Одно предложение."]


def call(model, q):
    body = {"model": model, "stream": True, "stream_options": {"include_usage": True}, "max_tokens": 300,
            "messages": [{"role": "system", "content": "Ты агент. Правила и код проекта:\n\n" + prefix},
                         {"role": "user", "content": q}]}
    req = urllib.request.Request("https://a6api.com/v1/chat/completions", data=json.dumps(body).encode(),
                                 headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"})
    t0 = time.time(); ttft = None; text = ""; usage = {}
    try:
        with urllib.request.urlopen(req, timeout=600) as r:
            for raw in r:
                line = raw.decode("utf-8", "ignore").strip()
                if not line.startswith("data:") or line == "data: [DONE]":
                    continue
                d = json.loads(line[5:])
                if d.get("usage"):
                    usage = d["usage"]
                for ch in d.get("choices") or []:
                    piece = (ch.get("delta") or {}).get("content") or ""
                    if piece and ttft is None:
                        ttft = time.time() - t0
                    text += piece
        err = None
    except Exception as e:  # keep going: a failed supplier is a data point
        err = repr(e)[:200]
    cached = ((usage.get("prompt_tokens_details") or {}).get("cached_tokens")) or usage.get("cache_read_input_tokens") or 0
    return {"model": model, "t0": t0, "ttft": ttft, "total": time.time() - t0, "prompt": usage.get("prompt_tokens"),
            "out": usage.get("completion_tokens"), "cached": cached, "text": text[:200], "err": err}


results = []
lock = threading.Lock()


def run(model):
    for i in range(N):
        r = call(model, QUESTIONS[i % len(QUESTIONS)])
        with lock:
            results.append(r)
            print(f"{model:26} #{i+1} ttft {r['ttft'] and round(r['ttft'],1)}s total {round(r['total'],1)}s "
                  f"prompt {r['prompt']} cached {r['cached']} err {r['err']}", flush=True)


ts = [threading.Thread(target=run, args=(m,)) for m in MODELS]
[t.start() for t in ts]; [t.join() for t in ts]

# match a6 log rows (supplier, price, billed) by model and start time
time.sleep(20)
req = urllib.request.Request("https://a6api.com/api/log/token", headers={"Authorization": "Bearer " + key})
rows = json.load(urllib.request.urlopen(req, timeout=90))["data"]
for r in results:
    cand = [x for x in rows if x["model_name"] == r["model"] and abs(x["created_at"] - r["t0"]) < r["total"] + 15]
    if cand:
        x = min(cand, key=lambda x: abs(x["created_at"] - r["t0"]))
        o = json.loads(x["other"]) if isinstance(x["other"], str) else {}
        r.update(supplier=o.get("marketplace_supplier_id"), price_in=o.get("marketplace_price_input_micros"),
                 price_out=o.get("marketplace_price_output_micros"), price_cache=o.get("marketplace_price_cache_read_micros"),
                 log_cache=o.get("cache_tokens"), usd=x["quota"] / 500000, frt_ms=o.get("frt"))
json.dump(results, open(os.path.join(OUT, "results.json"), "w"), ensure_ascii=False, indent=1)

print("\nmodel                      n  ok  med_ttft  cache_hit  usd_per_call  suppliers")
for m in MODELS:
    rs = [r for r in results if r["model"] == m]
    ok = [r for r in rs if not r["err"] and r["ttft"]]
    tt = sorted(r["ttft"] for r in ok)
    hit = sum(1 for r in ok if (r.get("log_cache") or r["cached"] or 0) > 0.5 * (r["prompt"] or 1))
    usd = [r["usd"] for r in rs if r.get("usd") is not None]
    sup = {}
    for r in rs:
        s = r.get("supplier")
        sup[s] = sup.get(s, 0) + 1
    print(f"{m:26} {len(rs):2} {len(ok):3}  {tt[len(tt)//2] if tt else 0:7.1f}s  {hit:2}/{len(ok):<2}     "
          f"${(sum(usd)/len(usd) if usd else 0):.5f}    {sup}")
print("saved", OUT)
