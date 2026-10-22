import json, collections
rows = [json.loads(l) for l in open("results_b.jsonl")]
crash = [r for r in rows if "crash" in r]; rows = [r for r in rows if "crash" not in r]
print("episodes", len(rows), "crashes", len(crash))
def agg(rs):
    n = len(rs); p = sum(r["passed"] for r in rs)
    calls = sum(r["tool_calls"] for r in rs)
    return {"n": n, "pass": f"{p}/{n} ({p/max(1,n):.0%})", "steps": round(sum(r["steps"] for r in rs)/max(1,n), 1),
            "malformed/100calls": round(100*sum(r["malformed"] for r in rs)/max(1,calls), 1),
            "edit_fail/100calls": round(100*sum(r["edit_fail"] for r in rs)/max(1,calls), 1),
            "false_claims": sum(r["false_claim"] for r in rs), "test_edits": sum(r["test_edit_attempts"] for r in rs),
            "http_err_eps": sum(1 for r in rs if r["errors"]),
            "prompt_k": round(sum(r["usage"]["prompt"] for r in rs)/max(1,n)/1000, 1), "cached%": round(100*sum(r["usage"]["cached"] for r in rs)/max(1,sum(r["usage"]["prompt"] for r in rs)))}
by_v = collections.defaultdict(list); by_m = collections.defaultdict(list); by_mv = collections.defaultdict(list); by_t = collections.defaultdict(list)
for r in rows:
    by_v[r["variant"]].append(r); by_m[r["model"]].append(r); by_mv[(r["model"], r["variant"])].append(r); by_t[r["task"]].append(r)
print("\nBY FORMAT"); [print(f"{k:8}", agg(v)) for k, v in sorted(by_v.items())]
print("\nBY MODEL"); [print(f"{k:26}", agg(v)) for k, v in sorted(by_m.items())]
print("\nMODEL x FORMAT (pass, malformed, edit_fail, steps)")
for (m, v), rs in sorted(by_mv.items()):
    a = agg(rs); print(f"{m:26} {v:7} pass {a['pass']:12} malf {a['malformed/100calls']:5} editfail {a['edit_fail/100calls']:5} steps {a['steps']} false {a['false_claims']} http {a['http_err_eps']}")
print("\nBY TASK"); [print(f"{k:10}", agg(v)["pass"]) for k, v in sorted(by_t.items())]
fails = [r for r in rows if not r["passed"]]
print("\nFAILED EPISODES:")
for r in fails: print(r["model"], r["variant"], r["task"], "steps", r["steps"], "errors", r["errors"][:1], "final", repr(r["final"][:80]))
