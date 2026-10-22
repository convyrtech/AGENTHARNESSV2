import json, collections, itertools
rows = [json.loads(l) for l in open("results_review.jsonl")]
rows = [r for r in rows if "crash" not in r]
print("rows", len(rows), "unparsed", sum(r["verdict"] == "?" for r in rows))
def stats(rs):
    ok = [r for r in rs if r["truth"] == "ok"]; bug = [r for r in rs if r["truth"] == "bug"]
    caught = sum(r["verdict"] == "reject" for r in bug); fa = sum(r["verdict"] == "approve" for r in bug)
    fr = sum(r["verdict"] == "reject" for r in ok)
    acc = sum(1 for r in rs if r["correct"]) / max(1, len(rs))
    return f"acc {acc:5.1%} | bugs caught {caught}/{len(bug)} | bugs approved {fa} | good rejected {fr}/{len(ok)}"
print("\nPer reviewer (both conditions):")
by = collections.defaultdict(list)
for r in rows: by[r["model"]].append(r)
for m, rs in sorted(by.items()):
    a = stats([r for r in rs if not r["with_report"]]); b = stats([r for r in rs if r["with_report"]])
    print(f"{m:26} PKG: {a}\n{'':26} +REPORT: {b}")
# pairs: approve only if both approve
print("\nTwo-reviewer combos (approve only if both approve), package condition:")
pk = {(r["model"], r["task"], r["idx"]): r for r in rows if not r["with_report"]}
models = sorted(by)
for a, b in itertools.combinations(models, 2):
    keys = [k[1:] for k in pk if k[0] == a and (b, *k[1:]) in pk]
    if not keys: continue
    res = []
    for t, i in keys:
        ra, rb = pk[(a, t, i)], pk[(b, t, i)]
        v = "approve" if ra["verdict"] == "approve" and rb["verdict"] == "approve" else "reject"
        res.append({"truth": ra["truth"], "verdict": v, "correct": (v == "approve") == (ra["truth"] == "ok")})
    print(f"{a} + {b}: {stats(res)}")
toks = collections.defaultdict(list)
for r in rows:
    if r.get("prompt_tokens"): toks[r["model"]].append((r["prompt_tokens"], r["completion_tokens"] or 0))
print("\navg tokens in/out:", {m: (round(sum(x for x, _ in v)/len(v)), round(sum(y for _, y in v)/len(v))) for m, v in toks.items()})
