"""База B набора «Исследовать» (research/26 §4.10, R0): встроенный поиск моделей через шлюз, как есть.

  python3 run_builtin.py probe [--base https://a6api.com] [--key-file ../.a6key] [--models gpt-6.1-sol,claude-opus-5-5,grok-4.7]
      есть ли каналы /v1/tools/search и /v1/tools/fetch; работает ли web_search_options у каждой модели
      (ответ с аннотациями url_citation или со ссылками) — «есть / нет» → probe.json
  python3 run_builtin.py run --model <id> --out results-<id>.jsonl [--only r01,i05] [--base …] [--key-file …]
      30 вопросов через Chat Completions с web_search_options → results.jsonl для score.py

Ключ читается из файла и никуда не пишется; в журнал идут только код ответа, время и использование токенов.
"""
import argparse, datetime as dt, json, re, sys, time, urllib.error, urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import live, score  # noqa: E402
URL = re.compile(r"https?://[^\s)\]>»\"']+")
SYSTEM = ("Сегодня {today}. Отвечай по-русски, коротко и по делу. Ищи в интернете свежие первоисточники. В конце — "
          "список источников: для каждого URL и дословную цитату со страницы, на которую опирается ответ.")


def post(base, key, path, body, timeout=180):
    req = urllib.request.Request(base.rstrip("/") + path, data=json.dumps(body).encode(), method="POST",
                                 headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw, status = r.read().decode("utf-8", "replace"), r.status
    except urllib.error.HTTPError as e:
        raw, status = e.read().decode("utf-8", "replace"), e.code
    except Exception as e:
        raw, status = str(e), 0
    try:
        data = json.loads(raw)
    except ValueError:
        data = None
    return status, data, raw[:300], round(time.time() - t0, 1)


def ask(base, key, model, question, today):
    body = {"model": model, "web_search_options": {},
            "messages": [{"role": "system", "content": SYSTEM.format(today=today)}, {"role": "user", "content": question}]}
    status, data, raw, secs = post(base, key, "/v1/chat/completions", body)
    if status != 200 or not data or not data.get("choices"):
        return {"answer": "", "sources": [], "seconds": secs, "annotations": 0, "error": f"HTTP {status}: {raw[:160]}"}
    msg = data["choices"][0].get("message") or {}
    text = msg.get("content") or ""
    sources, seen = [], set()
    for a in msg.get("annotations") or []:                 # OpenAI-совместимые цитаты встроенного поиска
        u = (a.get("url_citation") or {}).get("url") or a.get("url")
        if u and u not in seen:
            seen.add(u)
            sources.append({"url": u, "quote": None, "date": None, "via": "annotation"})
    for u in URL.findall(text):
        u = u.rstrip(".,;:")
        if u not in seen:
            seen.add(u)
            sources.append({"url": u, "quote": None, "date": None, "via": "text"})
    usage = data.get("usage") or {}
    cost = usage.get("cost") if isinstance(usage.get("cost"), (int, float)) else None
    return {"answer": text, "sources": sources, "seconds": secs, "usage": usage, "cost_usd": cost,
            "annotations": len(msg.get("annotations") or []), "error": None}


def probe(a, key):
    out = {"date": dt.datetime.now().astimezone().isoformat(timespec="seconds"), "base": a.base}
    s, d, raw, secs = post(a.base, key, "/v1/tools/search", {"query": "Пушкин", "count": 1}, 60)
    out["tools_search"] = {"status": s, "has_results": bool(d and (d.get("results") or d.get("data"))),
                           "seconds": secs, "sample": raw[:200]}
    s, d, raw, secs = post(a.base, key, "/v1/tools/fetch", {"url": "https://example.com"}, 60)
    out["tools_fetch"] = {"status": s, "has_content": bool(d) and s == 200, "seconds": secs, "sample": raw[:200]}
    today = dt.date.today().isoformat()
    # ссылку модель напишет и по памяти: поиск есть, только если есть аннотации поиска или сегодняшний курс ЦБ
    usd = live.cbr_rate("USD")
    out["usd_today"] = usd["answer"]
    out["models"] = {}
    for m in a.models.split(","):
        r = ask(a.base, key, m.strip(), "Какой официальный курс доллара ЦБ РФ на сегодня? Дай ссылку на источник.", today)
        fresh = score.check(usd["ref"], r["answer"])[0]
        out["models"][m] = {"works": bool(r["annotations"] or fresh) and not r["error"], "today_rate": fresh,
                            "annotations": r.get("annotations", 0), "links_in_text": sum(1 for x in r["sources"] if x["via"] == "text"),
                            "error": r["error"], "seconds": r["seconds"], "answer": r["answer"][:300]}
    Path(a.out or "probe.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps({k: v for k, v in out.items() if k != "models"}, ensure_ascii=False, indent=1))
    for m, v in out["models"].items():
        print(f"{m}: встроенный поиск {'есть' if v['works'] else 'нет'} (аннотаций {v['annotations']}, сегодняшний курс "
              f"{'назван' if v['today_rate'] else 'не назван'}, ссылок в тексте {v['links_in_text']})"
              f"{' — ' + v['error'] if v['error'] else ''}")


def run(a, key):
    qs = json.loads((HERE / "questions.json").read_text(encoding="utf-8"))["questions"]
    only = set(a.only.split(",")) if a.only else None
    today = dt.date.today().isoformat()
    out = Path(a.out)
    done = {json.loads(x)["id"] for x in out.read_text(encoding="utf-8").splitlines() if x.strip()} if out.exists() else set()
    with open(out, "a", encoding="utf-8") as f:
        for q in qs:
            if (only and q["id"] not in only) or q["id"] in done:
                continue
            r = ask(a.base, key, a.model, q["q"], today)
            r["id"], r["model"], r["queries"] = q["id"], a.model, []   # запросы встроенного поиска шлюз не отдаёт
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
            f.flush()
            print(q["id"], "ошибка: " + r["error"] if r["error"] else f"{r['seconds']} с, источников {len(r['sources'])}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["probe", "run"])
    ap.add_argument("--base", default="https://a6api.com")
    ap.add_argument("--key-file", default=str(HERE.parent / ".a6key"))
    ap.add_argument("--models", default="gpt-6.1-sol,claude-opus-5-5,grok-4.7")
    ap.add_argument("--model")
    ap.add_argument("--out")
    ap.add_argument("--only")
    a = ap.parse_args()
    key = Path(a.key_file).read_text(encoding="utf-8").strip()
    if a.cmd == "run" and not (a.model and a.out):
        sys.exit("run: нужны --model и --out")
    (probe if a.cmd == "probe" else run)(a, key)


if __name__ == "__main__":
    main()
