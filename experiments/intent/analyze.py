import json, collections, os, sys, itertools
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE); import requests as RQ
kinds = {r["id"]: r["kind"] for r in RQ.R}
rows = [json.loads(l) for l in open(os.path.join(HERE, "judgments.jsonl"))]
rows = [r for r in rows if r.get("winner")]
V = ["direct", "brief", "deep", "premium"]
def table(rs, title):
    wins = collections.Counter(); games = collections.Counter(); ties = collections.Counter()
    for r in rs:
        for v in (r["a"], r["b"]): games[v] += 1
        if r["winner"] == "tie": ties[r["a"]] += 1; ties[r["b"]] += 1
        else: wins[r["winner"]] += 1
    print(f"\n{title} (n={len(rs)})")
    for v in sorted(V, key=lambda v: -(wins[v] + 0.5 * ties[v]) / max(1, games[v])):
        print(f"  {v:8} score {(wins[v] + 0.5 * ties[v]) / max(1, games[v]):.0%}  (wins {wins[v]}, ties {ties[v]}, games {games[v]})")
table(rows, "ALL")
table([r for r in rows if kinds[r["id"]] == "web"], "WEB pages")
table([r for r in rows if kinds[r["id"]] == "text"], "TEXTS")
for j in sorted({r["judge"] for r in rows}): table([r for r in rows if r["judge"] == j], f"judge {j}")
# head-to-head deep vs direct per request
print("\nper request winner counts (deep vs direct, brief vs direct, deep vs premium):")
for rid in [r["id"] for r in RQ.R]:
    def h2h(x, y):
        rs = [r for r in rows if r["id"] == rid and {r["a"], r["b"]} == {x, y}]
        return f"{sum(r['winner']==x for r in rs)}-{sum(r['winner']==y for r in rs)}"
    print(f"  {rid:10} deep:direct {h2h('deep','direct'):5} brief:direct {h2h('brief','direct'):5} deep:premium {h2h('deep','premium'):5}")
# position bias check
first = sum(1 for r in rows if r["winner"] == r["a"]); second = sum(1 for r in rows if r["winner"] == r["b"])
print(f"\nposition bias: first shown won {first}, second shown won {second}, ties {sum(r['winner']=='tie' for r in rows)}")
