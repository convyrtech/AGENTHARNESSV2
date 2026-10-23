"""Real a6 charge per E8b turn: sums /api/log/token rows inside each turn's time window (Pi's own cost counter
uses the price from models.json, not what the routed supplier billed)."""
import sys, os, json, glob, time, urllib.request, datetime as dt
HERE = os.path.dirname(os.path.abspath(__file__))
key = open(os.path.join(os.path.dirname(HERE), ".a6key")).read().strip()
ws = sys.argv[1] if len(sys.argv) > 1 else "/home/user/e8b-ds"
req = urllib.request.Request("https://a6api.com/api/log/token", headers={"Authorization": "Bearer " + key})
rows = [x for x in json.load(urllib.request.urlopen(req, timeout=90))["data"] if x["model_name"].startswith("deepseek")]


def starts(ws):
    """Turn N starts when the owner's message N lands in the channel (drive.py writes it right before pi runs)."""
    out = []
    for line in open(os.path.join(ws, "owner", "messages.jsonl"), encoding="utf-8"):
        m = json.loads(line)
        out.append(dt.datetime.strptime(m["date"], "%Y%m%d-%H%M%S").replace(tzinfo=dt.timezone.utc).timestamp())
    return out


total = 0.0
st = starts(ws)
for n, t0 in enumerate(st, 1):
    t1 = st[n] if n < len(st) else time.time()
    rs = [x for x in rows if t0 <= x["created_at"] < t1]
    usd = sum(x["quota"] for x in rs) / 500000
    total += usd
    sup = {}
    for x in rs:
        o = json.loads(x["other"]) if isinstance(x["other"], str) else {}
        s = o.get("marketplace_supplier_id")
        sup[s] = sup.get(s, 0) + 1
    lat = sorted(x["use_time"] for x in rs)
    med = lat[len(lat) // 2] if lat else 0
    print(f"turn {n:2}  calls {len(rs):3}  ${usd:.4f}  median {med:3}s  max {max(lat or [0]):3}s  suppliers {sup}")
print(f"TOTAL ${total:.4f}")
