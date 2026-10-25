"""Метрики набора «Исследовать» (research/26 §4.11) по ответам любого исполнителя.

  python3 score.py <results.jsonl> --out <папка> [--questions questions.json] [--no-fetch]

results.jsonl — строка на вопрос:
  {"id": "r04", "answer": "текст ответа", "sources": [{"url": "...", "quote": "дословная цитата", "date": "2026-10-17"}],
   "queries": ["поисковые запросы, если были"], "cost_usd": 0.012, "seconds": 41.5, "error": null}

Что считает (каждое — кодом):
- точность ответа: эталон из questions.json (frozen) или из первоисточника сейчас (live.py); открытые вопросы
  (kind=rubric с полем judge) — обязательные пункты кодом, остальное помечается «нужен судья»;
- точность цитат: цитата найдена в тексте страницы (без регистра, пробелов, разметки, кавычек, ё/е; не короче 3 слов
  или 20 знаков) — доля от всех [n]; сверку моделью добавит R4;
- живые ссылки: доля URL с ответом 200/3xx;
- свежесть: доля источников с датой; запросы с прошлым годом, которого нет в вопросе;
- цена и время: p50 и p90 на вопрос.
Выход: <out>/report.json, <out>/report.md, тексты страниц — <out>/pages/.
"""
import argparse, datetime as dt, hashlib, html, json, re, sys, time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import live  # noqa: E402

HERE = Path(__file__).resolve().parent


# ---------- нормализация ----------
def norm_answer(text):
    """Нижний регистр, ё→е, неразрывные пробелы, пробелы внутри чисел убраны, десятичная запятая → точка."""
    t = (text or "").lower().replace("ё", "е")
    t = re.sub(r"[   ]", " ", t)
    for _ in range(3):
        t = re.sub(r"(\d) (\d{3})(?!\d)", r"\1\2", t)
    t = re.sub(r"(\d),(\d)", r"\1.\2", t)
    return re.sub(r"\s+", " ", t)


QUOTES = "«»„“”‟\"'‘’`"


def norm_quote(text):
    """Для сверки цитаты с текстом страницы (research/26 §4.4 п. 2)."""
    t = (text or "").lower().replace("ё", "е")
    t = re.sub(r"[*_#>|~\[\]()]", " ", t)
    t = "".join(" " if c in QUOTES else c for c in t)
    t = re.sub(r"[   \s]+", " ", t)
    return t.strip(" .,;:—–-")


def quote_long_enough(q):
    n = norm_quote(q)
    return len(n.split()) >= 3 or len(n) >= 20


def page_text(raw):
    t = raw.decode("utf-8", "replace")
    if "charset=windows-1251" in t[:3000].lower():
        t = raw.decode("cp1251", "replace")
    t = re.sub(r"<script.*?</script>|<style.*?</style>", " ", t, flags=re.S | re.I)
    return html.unescape(re.sub(r"<[^>]+>", " ", t))


# ---------- точность ----------
NUMBER = re.compile(r"(?<![\d.])\d+(?:\.\d+)?(?![\d.])")


def check(ref, answer):
    """(ок, что не так) по эталону."""
    a = norm_answer(answer)
    if not a.strip():
        return False, "пустой ответ"
    if "number" in ref:
        nums = [float(x) for x in NUMBER.findall(a)]
        ok = any(abs(x - ref["number"]) <= ref.get("tol", 0) for x in nums)
        return ok, "" if ok else f"нет числа {ref['number']}±{ref.get('tol', 0)}"
    for rx in ref.get("must", []):
        if not re.search(rx, a):
            return False, f"нет «{rx}»"
    for group in ref.get("any", []):
        if not any(re.search(rx, a) for rx in group):
            return False, "нет ни одного из «" + " | ".join(group) + "»"
    for rx in ref.get("none", []):
        if re.search(rx, a):
            return False, f"есть лишнее «{rx}»"
    return True, ""


def references(questions, cache_file):
    """Эталон на каждый вопрос: frozen — из набора, live — из первоисточника (кэш на прогон оценки)."""
    cache = json.loads(cache_file.read_text(encoding="utf-8")) if cache_file.exists() else {}
    out = {}
    for q in questions:
        if q.get("live"):
            if q["id"] not in cache:
                try:
                    cache[q["id"]] = live.resolve(q["live"])
                except Exception as e:
                    cache[q["id"]] = {"error": str(e)}
            out[q["id"]] = cache[q["id"]]
        else:
            out[q["id"]] = {"answer": q.get("answer"), "ref": q["ref"], "checked": q.get("checked"),
                            "recheck": q.get("recheck", False)}
    cache_file.write_text(json.dumps(cache, ensure_ascii=False, indent=1), encoding="utf-8")
    return out


# ---------- источники ----------
def fetch_page(url, pages, timeout=30):
    """(код, текст страницы) с кэшем в pages/."""
    key = hashlib.sha1(url.encode()).hexdigest()[:16]
    meta, txt = pages / f"{key}.json", pages / f"{key}.txt"
    if meta.exists() and json.loads(meta.read_text(encoding="utf-8"))["status"]:
        return json.loads(meta.read_text(encoding="utf-8"))["status"], txt.read_text(encoding="utf-8")
    status, text, error = 0, "", ""
    for attempt in range(3):              # сайты режут частые запросы (consultant.ru рвёт соединение): пауза и ещё раз
        try:
            raw, status = live.get(url, timeout)
            text = page_text(raw)
            break
        except Exception as e:
            error = str(e)
            time.sleep(3 * (attempt + 1))
    meta.write_text(json.dumps({"url": url, "status": status, **({"error": error} if not status else {})}),
                    encoding="utf-8")
    txt.write_text(text, encoding="utf-8")
    return status, text


def past_year_queries(question, queries, year):
    """Запросы с годом раньше нынешнего, которого нет в самом вопросе (сбой 1 владельца)."""
    asked = set(re.findall(r"\b(?:19|20)\d\d\b", question))
    bad = []
    for q in queries or []:
        years = {int(y) for y in re.findall(r"\b(?:19|20)\d\d\b", q)}
        if any(y < year and str(y) not in asked for y in years):
            bad.append(q)
    return bad


def pct(xs, p):
    xs = sorted(x for x in xs if x is not None)
    if not xs:
        return None
    k = (len(xs) - 1) * p
    lo, hi = int(k), min(int(k) + 1, len(xs) - 1)
    return round(xs[lo] + (xs[hi] - xs[lo]) * (k - lo), 4)


def score(results, questions, out, fetch=True):
    out.mkdir(parents=True, exist_ok=True)
    pages = out / "pages"
    pages.mkdir(exist_ok=True)
    refs = references(questions, out / "live-refs.json")
    year = dt.date.today().year
    byq = {q["id"]: q for q in questions}
    rows, cites, links, dated, total_src, bad_queries, n_queries = [], [], [], 0, 0, [], 0
    for r in results:
        q = byq.get(r.get("id"))
        if not q:
            continue
        ref = refs[q["id"]]
        ok, why = check(ref["ref"], r.get("answer", "")) if "ref" in ref else (None, "эталон не получен: " + ref.get("error", ""))
        row = {"id": q["id"], "topic": q["topic"], "ok": ok, "why": why, "judge": bool(q.get("judge")),
               "recheck": bool(ref.get("recheck")), "cost_usd": r.get("cost_usd"), "seconds": r.get("seconds"),
               "error": r.get("error"), "sources": [], "reference": ref.get("answer")}
        for s in r.get("sources") or []:
            total_src += 1
            dated += bool(s.get("date"))
            item = {"url": s.get("url"), "date": s.get("date")}
            if fetch and s.get("url"):
                status, text = fetch_page(s["url"], pages)
                item["status"] = status
                links.append(200 <= status < 400)
                if s.get("quote"):
                    found = quote_long_enough(s["quote"]) and norm_quote(s["quote"]) in norm_quote(text)
                    item["quote_found"] = found
                    cites.append(found)
                else:
                    item["quote_found"] = None
                    cites.append(False)
            row["sources"].append(item)
        bad = past_year_queries(q["q"], r.get("queries"), year)
        n_queries += len(r.get("queries") or [])
        bad_queries += [{"id": q["id"], "query": x} for x in bad]
        rows.append(row)
    scored = [x for x in rows if x["ok"] is not None]
    summary = {
        "date": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
        "questions": len(rows),
        "accuracy": round(sum(x["ok"] for x in scored) / len(scored), 3) if scored else None,
        "accuracy_ru": _acc(scored, "ru"), "accuracy_intl": _acc(scored, "intl"),
        "needs_judge": [x["id"] for x in rows if x["judge"]],
        "recheck_reference": [x["id"] for x in rows if x["recheck"]],
        "citations": len(cites), "citations_found_share": round(sum(cites) / len(cites), 3) if cites else None,
        "links_alive_share": round(sum(links) / len(links), 3) if links else None,
        "sources_dated_share": round(dated / total_src, 3) if total_src else None,
        "queries": n_queries, "past_year_queries": bad_queries,
        "cost_usd_p50": pct([x["cost_usd"] for x in rows], 0.5), "cost_usd_p90": pct([x["cost_usd"] for x in rows], 0.9),
        "seconds_p50": pct([x["seconds"] for x in rows], 0.5), "seconds_p90": pct([x["seconds"] for x in rows], 0.9),
        "errors": [x["id"] for x in rows if x["error"]],
    }
    (out / "report.json").write_text(json.dumps({"summary": summary, "rows": rows}, ensure_ascii=False, indent=1),
                                     encoding="utf-8")
    (out / "report.md").write_text(report_md(summary, rows), encoding="utf-8")
    return summary, rows


def _acc(rows, topic):
    xs = [x["ok"] for x in rows if x["topic"] == topic]
    return round(sum(xs) / len(xs), 3) if xs else None


def report_md(s, rows):
    fmt = lambda v: "—" if v is None else (f"{v:.0%}" if isinstance(v, float) and v <= 1 else str(v))
    lines = [f"# Набор «Исследовать»: оценка ({s['date']})", "",
             "| Метрика | Значение |", "|---|---|",
             f"| Вопросов | {s['questions']} |",
             f"| Точность ответа (Россия / мир) | {fmt(s['accuracy'])} ({fmt(s['accuracy_ru'])} / {fmt(s['accuracy_intl'])}) |",
             f"| Цитаты найдены в тексте страницы | {fmt(s['citations_found_share'])} из {s['citations']} |",
             f"| Живые ссылки | {fmt(s['links_alive_share'])} |",
             f"| Источники с датой | {fmt(s['sources_dated_share'])} |",
             f"| Запросы с прошлым годом | {len(s['past_year_queries'])} из {s['queries']} |",
             f"| Цена на вопрос p50 / p90, $ | {s['cost_usd_p50']} / {s['cost_usd_p90']} |",
             f"| Время на вопрос p50 / p90, с | {s['seconds_p50']} / {s['seconds_p90']} |", ""]
    if s["needs_judge"]:
        lines.append("Открытые вопросы, нужен судья другой семьи (обязательные пункты уже проверены кодом): "
                     + ", ".join(s["needs_judge"]) + ".")
    if s["recheck_reference"]:
        lines.append("Эталон сверить руками перед выводами: " + ", ".join(s["recheck_reference"]) + ".")
    lines += ["", "| Вопрос | Верно | Что не так | Источников (цитата найдена) | $ | с |", "|---|---|---|---|---|---|"]
    for r in rows:
        found = sum(1 for x in r["sources"] if x.get("quote_found"))
        lines.append(f"| {r['id']} | {'да' if r['ok'] else ('нет' if r['ok'] is False else '—')} | {r['why'] or r['error'] or ''} "
                     f"| {len(r['sources'])} ({found}) | {r['cost_usd'] if r['cost_usd'] is not None else '—'} "
                     f"| {r['seconds'] if r['seconds'] is not None else '—'} |")
    return "\n".join(lines) + "\n"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("results")
    ap.add_argument("--out", required=True)
    ap.add_argument("--questions", default=str(HERE / "questions.json"))
    ap.add_argument("--no-fetch", action="store_true", help="не открывать страницы (только точность, цена, время)")
    a = ap.parse_args()
    questions = json.loads(Path(a.questions).read_text(encoding="utf-8"))["questions"]
    results = [json.loads(x) for x in Path(a.results).read_text(encoding="utf-8").splitlines() if x.strip()]
    s, _ = score(results, questions, Path(a.out), fetch=not a.no_fetch)
    print(json.dumps(s, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
