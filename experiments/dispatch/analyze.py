import json, collections, sys, os
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE); import catalog
for mode in ("B", "A"):
    p = os.path.join(HERE, f"results_{mode}.jsonl")
    if not os.path.exists(p): continue
    rows = [json.loads(l) for l in open(p)]
    print(f"\n=== MODE {mode} ({'dedicated dispatcher' if mode=='B' else 'agent self-selects from full catalog'})  rows={len(rows)}")
    by = collections.defaultdict(list)
    for r in rows: by[r["model"]].append(r)
    print(f"{'model':26} recall  needed-tasks-with-zero-skills  false-triggers/task  no-skill-tasks-clean  errors  avg_picked  secs/in-tok")
    for m, rs in sorted(by.items()):
        g = sum(r["groups"] for r in rs); s = sum(r["satisfied"] for r in rs)
        need = [r for r in rs if r["groups"]]; zero = sum(1 for r in need if r["n_picked"] == 0)
        nos = [r for r in rs if not r["groups"]]; clean = sum(1 for r in nos if r["n_picked"] == 0)
        ft = sum(len(r["false"]) for r in need) / max(1, len(need)); errs = sum(1 for r in rs if r.get("err"))
        avgp = sum(r["n_picked"] for r in rs) / len(rs)
        extra = f"{sum(r.get('secs',0) for r in rs)/len(rs):.1f}s" if mode == "B" else f"{sum(r['usage']['p'] for r in rs)/len(rs)/1000:.1f}k"
        print(f"{m:26} {s}/{g} ({s/max(1,g):.0%})   {zero}/{len(need)}   {ft:.2f}   {clean}/{len(nos)}   {errs}   {avgp:.1f}   {extra}")
    fc = collections.Counter(x for r in rows for x in r["false"]); print("most common false triggers:", fc.most_common(8))
    miss = collections.Counter()
    for r in rows:
        t = catalog.TASKS[r["task"]]
        for gr in t["gold"]:
            if not set(r["picked"]) & set(gr): miss["/".join(gr)] += 1
    print("most missed:", miss.most_common(8))
