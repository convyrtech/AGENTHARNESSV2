"""Сравнение двух прогонов simulate.py (дирижёр и одна сессия) и лист для слепого выбора владельца.

  abreport.py cost --record <запись> --key-file <ключ a6> [--a6-url https://a6api.com]
      забрать журнал a6 (/api/log/token) и оставить строки внутри окон ходов прогона → <запись>/a6-rows.json.
      Журнал отдаёт только последние 1000 строк: звать сразу после прогона (simulate.py --key-file делает это сам)
      и не гонять два прогона одновременно — окна времени перекроются.
  abreport.py compare <запись A> <запись B> --out <папка> [--pipeline <design-pipeline>] [--python <python>]
      <out>/report.md и report.json: деньги по журналу a6 (quota / 500000 = $), минуты и вызовы агентов, сообщения
      владельца и повторы вопросов, до какого шага дошли;
      <out>/blind/sheet.png: финальные страницы рядом (390×844 и 1440×900, compare_sheet.py), подписи А/Б в
      случайном порядке; какая буква чья — только в <out>/blind-key.json.
"""
import argparse, json, random, shutil, subprocess, sys, time, urllib.request
from pathlib import Path
for _s in (sys.stdout, sys.stderr):  # Windows: под -I PYTHONUTF8 не действует, а вывод в трубу идёт в cp1252
    _s.reconfigure(encoding="utf-8", errors="replace")

USD_PER_QUOTA = 1 / 500000
GRACE = 5                       # строка журнала пишется по концу вызова: окно хода чуть шире
LABELS = ("А", "Б")


def read_jsonl(path):
    out = []
    if Path(path).exists():
        for ln in Path(path).read_text(encoding="utf-8").splitlines():
            try:
                out.append(json.loads(ln))
            except ValueError:
                pass
    return out


def windows(rec):
    return [(t["t0"], t["t1"] + GRACE) for t in read_jsonl(Path(rec) / "turns.jsonl")]


# ---------- cost ----------
def fetch_rows(url, key):
    req = urllib.request.Request(url.rstrip("/") + "/api/log/token", headers={"Authorization": "Bearer " + key})
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.load(r)["data"]


def cost(a):
    rec = Path(a.record)
    key = Path(a.key_file).read_text(encoding="utf-8").strip()
    rows = fetch_rows(a.a6_url, key)
    win = windows(rec)
    if not win:
        sys.exit("abreport cost: в записи нет ходов (turns.jsonl)")
    mine = [x for x in rows if any(t0 <= x["created_at"] <= t1 for t0, t1 in win)]
    oldest = min((x["created_at"] for x in rows), default=None)
    covered = oldest is not None and (len(rows) < 1000 or oldest <= win[0][0])
    (rec / "a6-rows.json").write_text(json.dumps({"fetched_at": time.time(), "covered": covered, "rows": mine},
                                                 ensure_ascii=False, indent=1), encoding="utf-8")
    s = summarize_cost(mine)
    print(f"a6: вызовов {s['calls']}, ${s['usd']:.4f}" + ("" if covered else
          " — ВНИМАНИЕ: журнал a6 начинается позже прогона, часть вызовов не попала"))
    for m, v in s["by_model"].items():
        print(f"  {m}: {v['calls']} выз., ${v['usd']:.4f}")


def summarize_cost(rows):
    by = {}
    for x in rows:
        m = by.setdefault(x.get("model_name", "?"), {"calls": 0, "usd": 0.0})
        m["calls"] += 1
        m["usd"] += x.get("quota", 0) * USD_PER_QUOTA
    return {"calls": len(rows), "usd": round(sum(v["usd"] for v in by.values()), 4),
            "by_model": {k: {"calls": v["calls"], "usd": round(v["usd"], 4)} for k, v in sorted(by.items())}}


# ---------- compare ----------
def metrics(rec):
    rec = Path(rec)
    run = json.loads((rec / "run.json").read_text(encoding="utf-8"))
    turns = read_jsonl(rec / "turns.jsonl")
    ledger = read_jsonl(rec / "state" / "ledger.jsonl")
    agent = [r for r in ledger if r.get("kind") in ("stage", "fix")]
    asked = [t["key"] for t in turns if t.get("end") == "owner"]
    per_key = {}
    for k in asked:
        per_key[k] = per_key.get(k, 0) + 1
    m = {
        "driver": run["driver"], "model": run.get("model"), "ws": run["ws"], "page": run["page"],
        "reached_gate": run.get("reached_gate"), "done": run.get("done"), "stop": run.get("stop"),
        "owner_messages": sum(1 for t in turns if t.get("sent")),
        "questions": len(asked), "question_keys": asked,
        "repeats": sum(n - 1 for n in per_key.values()),
        "repeated_keys": sorted(k for k, n in per_key.items() if n > 1),
        "unscripted_answers": sum(1 for t in turns if t.get("scripted") is False),
        "turns": len(turns),
        "agent_minutes": round(sum(r.get("seconds", 0) or 0 for r in agent) / 60, 1),
        "tool_calls": sum(r.get("calls", 0) or 0 for r in agent),
        "launches": len(agent),
        "sessions": sum(1 for p in (rec / "state" / "sessions").glob("*.jsonl") if not p.name.endswith(".events.jsonl")),
        "killed": sum(1 for r in agent if r.get("killed")),
        "escalations": sum(1 for r in ledger if r.get("kind") == "escalate"),
        "judge_calls": sum(1 for r in ledger if r.get("kind") == "judge"),
        "wall_minutes": round(sum(t["t1"] - t["t0"] for t in turns) / 60, 1),
        "pi_cost_usd": round(sum(r.get("cost", 0) or 0 for r in agent), 4),
    }
    a6 = rec / "a6-rows.json"
    if a6.exists():
        d = json.loads(a6.read_text(encoding="utf-8"))
        m["a6"] = {**summarize_cost(d["rows"]), "covered": d.get("covered", True)}
    else:
        m["a6"] = None
    return m


ROWS = [("Дошёл до шага", lambda m: "все пройдены" if m["done"] else str(m["reached_gate"])),
        ("Почему остановился", lambda m: m["stop"]),
        ("Деньги по журналу a6", lambda m: (f"${m['a6']['usd']:.4f} ({m['a6']['calls']} выз.)" +
                                            ("" if m["a6"]["covered"] else " неполный журнал")) if m["a6"] else "не забран"),
        ("Счётчик Pi (кэш по полной цене, не верить)", lambda m: f"${m['pi_cost_usd']:.4f}"),
        ("Минут работы агентов", lambda m: m["agent_minutes"]),
        ("Минут на ходы (стенка)", lambda m: m["wall_minutes"]),
        ("Вызовов инструментов", lambda m: m["tool_calls"]),
        ("Сессий Pi / запусков", lambda m: f"{m['sessions']} / {m['launches']}"),
        ("Остановлено харнессом", lambda m: m["killed"]),
        ("Вызовов судьи", lambda m: m["judge_calls"]),
        ("Сообщений владельца", lambda m: m["owner_messages"]),
        ("Вопросов владельцу", lambda m: m["questions"]),
        ("Повторов вопроса", lambda m: f"{m['repeats']}" + (f" ({', '.join(m['repeated_keys'])})" if m["repeats"] else "")),
        ("Ответов не по сценарию", lambda m: m["unscripted_answers"]),
        ("Шаги вопросов", lambda m: " ".join(m["question_keys"]))]


def report_md(ma, mb):
    head = f"| | A: {ma['driver']} ({ma['model']}) | B: {mb['driver']} ({mb['model']}) |"
    lines = ["# A/B харнесса", "", head, "|---|---|---|"]
    lines += [f"| {name} | {f(ma)} | {f(mb)} |" for name, f in ROWS]
    for tag, m in (("A", ma), ("B", mb)):
        if m["a6"] and m["a6"]["by_model"]:
            lines += ["", f"Деньги {tag} по моделям: " +
                      ", ".join(f"{k} ${v['usd']:.4f} ({v['calls']})" for k, v in m["a6"]["by_model"].items())]
    return "\n".join(lines) + "\n"


def blind_sheet(ma, mb, out, pipeline, python, rng):
    pages = [Path(m["ws"]) / "site" / m["page"] / "index.html" for m in (ma, mb)]
    missing = [str(p) for p in pages if not p.exists()]
    if missing:
        return {"error": "нет страницы: " + ", ".join(missing)}
    order = [0, 1]
    rng.shuffle(order)
    sheet = out / "blind" / "sheet.png"
    sheet.parent.mkdir(parents=True, exist_ok=True)
    tool = Path(pipeline) / "tools" / "compare_sheet.py"
    r = subprocess.run([python, "-I", str(tool), "--engine", "chromium", "--labels", ",".join(LABELS),
                        *[x for i in order for x in ("--variant", str(pages[i]))], "--out", str(sheet)],
                       capture_output=True, text=True, encoding="utf-8")
    for side in (sheet.with_suffix(".json"), sheet.with_name(sheet.name + ".json")):
        side.unlink(missing_ok=True)                       # compare_sheet пишет рядом пути вариантов: это и есть ответ
    if r.returncode or not sheet.exists():
        return {"error": "compare_sheet: " + (r.stdout + r.stderr)[-400:]}
    who = (ma, mb)
    key = {LABELS[pos]: {"driver": who[i]["driver"], "record": "AB"[i], "page": str(pages[i])}
           for pos, i in enumerate(order)}
    (out / "blind-key.json").write_text(json.dumps(key, ensure_ascii=False, indent=1), encoding="utf-8")
    return {"sheet": str(sheet)}


def compare(a):
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    ma, mb = metrics(a.a), metrics(a.b)
    (out / "report.md").write_text(report_md(ma, mb), encoding="utf-8")
    pipeline = a.pipeline or str(Path(ma["ws"]) / "design-pipeline")
    rng = random.Random(a.seed) if a.seed is not None else random.SystemRandom()
    sheet = blind_sheet(ma, mb, out, pipeline, a.python, rng)
    (out / "report.json").write_text(json.dumps({"A": ma, "B": mb, "blind": sheet}, ensure_ascii=False, indent=1),
                                     encoding="utf-8")
    print((out / "report.md").read_text(encoding="utf-8"))
    print("слепой лист: " + sheet.get("sheet", sheet.get("error", "")) +
          ("  (ключ — blind-key.json, владельцу не показывать)" if "sheet" in sheet else ""))
    if not (ma["a6"] and mb["a6"]):
        print("деньги: журнал a6 забран не для обоих прогонов (abreport.py cost сразу после прогона)")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sp = ap.add_subparsers(dest="cmd", required=True)
    c = sp.add_parser("cost")
    c.add_argument("--record", required=True); c.add_argument("--key-file", required=True)
    c.add_argument("--a6-url", default="https://a6api.com")
    m = sp.add_parser("compare")
    m.add_argument("a"); m.add_argument("b"); m.add_argument("--out", required=True)
    m.add_argument("--pipeline"); m.add_argument("--python", default=sys.executable)
    m.add_argument("--seed", type=int, help="порядок подписей (для тестов); по умолчанию случайный")
    a = ap.parse_args(argv)
    {"cost": cost, "compare": compare}[a.cmd](a)


if __name__ == "__main__":
    main()
