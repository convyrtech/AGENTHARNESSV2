"""Cost of a council run: sums a6 per-request charges (from /api/log/token) inside the run's time window."""
import sys, os, json, glob, time, urllib.request
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
key = open(os.path.join(ROOT, ".a6key")).read().strip()
t0, t1 = float(sys.argv[1]), float(sys.argv[2])
req = urllib.request.Request("https://a6api.com/api/log/token", headers={"Authorization": "Bearer " + key})
data = json.load(urllib.request.urlopen(req, timeout=90))["data"]
rows = [x for x in data if t0 - 5 <= x["created_at"] <= t1 + 5]
by = {}
for x in rows:
    m = by.setdefault(x["model_name"], {"calls": 0, "usd": 0.0, "in": 0, "out": 0})
    m["calls"] += 1; m["usd"] += x["quota"] / 500000; m["in"] += x["prompt_tokens"]; m["out"] += x["completion_tokens"]
for k, v in sorted(by.items(), key=lambda kv: -kv[1]["usd"]):
    print(f"{k:26} calls {v['calls']:3}  in {v['in']:7}  out {v['out']:7}  ${v['usd']:.4f}")
print(f"TOTAL ${sum(v['usd'] for v in by.values()):.4f}  over {len(rows)} requests, {round((t1-t0)/60,1)} min")
