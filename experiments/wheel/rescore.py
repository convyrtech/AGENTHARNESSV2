"""Re-score wheel results from raw logs with the fixed code extraction; list truncated runs to redo."""
import json, glob, os, re, sys
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE); import run
pat = {t[0]: t[2] for t in run.TASKS}
latest = {}
for f in sorted(glob.glob(os.path.join(HERE, "..", "logs", "*-wh-*.json"))):
    name = os.path.basename(f)[11:-5]  # strip HHMMSS-NNN-
    latest[name] = f
rows, redo = [], []
for name, f in latest.items():
    d = json.load(open(f)); r = d.get("response") or {}
    if "chunks" in d:
        txt = "".join(((c.get("choices") or [{}])[0].get("delta") or {}).get("content") or "" for c in d["chunks"] if isinstance(c, dict))
        fin = next((((c.get("choices") or [{}])[0].get("finish_reason")) for c in reversed(d["chunks"]) if isinstance(c, dict) and (c.get("choices") or [{}])[0].get("finish_reason")), None)
        r = {"choices": [{"message": {"content": txt}, "finish_reason": fin}]}
    m = d["request"]["model"]; _, rest = name.split("wh-", 1)
    variant = next(v for v in ("plain", "prior_art", "ambitious") if f"-{v}-" in rest); task = rest.rsplit("-", 1)[1]
    ch = (r.get("choices") or [{}])[0] if isinstance(r, dict) else {}
    text = (ch.get("message") or {}).get("content") or ""
    blocks = re.findall(r"```(\w*)[^\n]*\n(.*?)```", text, re.S)
    code = "\n".join(b for lang, b in blocks if lang.lower() in ("", "python", "py", "python3")) or text
    imports = "\n".join(l for l in code.splitlines() if re.match(r"\s*(import|from)\s", l))
    p = pat[task]
    rec = {"model": m, "variant": variant, "task": task, "finish": ch.get("finish_reason"), "status": d["status"],
           "reused": bool(re.search(p, imports)), "recommends": bool(re.search(p.replace(r"\b(", "(").replace(r")\b", ")"), text, re.I)),
           "empty": len(text.strip()) < 50}
    if rec["finish"] == "length" or rec["empty"] or d["status"] != 200: redo.append((m, variant, task))
    rows.append(rec)
json.dump(rows, open(os.path.join(HERE, "rescored.json"), "w"), ensure_ascii=False, indent=0)
print("rows", len(rows), "redo", len(redo)); print(sorted(set((a, b) for a, b, c in redo)))
