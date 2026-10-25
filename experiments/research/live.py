"""Живые эталоны набора «Исследовать» (research/26 §4.11): ответ берётся из первоисточника в момент оценки.

  python3 live.py              напечатать все живые эталоны (проверка, что первоисточники открываются)

Каждый эталон — {"answer": текст, "ref": {...как в questions.json}, "fetched_at": ISO}. Сеть: urllib, при сбое TLS
(прокси со своим сертификатом) — curl.
"""
import datetime as dt, json, re, subprocess, sys, urllib.request

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36"


def get(url, timeout=30):
    """Тело ответа (bytes) и код; urllib, при ошибке соединения — curl."""
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "ru,en"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.read(), r.status
    except urllib.error.HTTPError as e:
        return e.read(), e.code
    except Exception:
        r = subprocess.run(["curl", "-sSL", "-m", str(timeout), "-A", UA, "-w", "\n%{http_code}", url],
                           capture_output=True)
        body, _, code = r.stdout.rpartition(b"\n")
        if not int(code or 0):
            raise RuntimeError(f"{url}: нет ответа ({r.stderr.decode('utf-8', 'replace').strip()[:120]})")
        return body, int(code)


def get_json(url):
    body, code = get(url)
    if code != 200:
        raise RuntimeError(f"{url}: HTTP {code}")
    return json.loads(body)


def num_re(x):
    """Версия или число как регулярное выражение по нормализованному тексту."""
    return re.escape(str(x))


def cbr_key_rate():
    body, _ = get("https://www.cbr.ru/hd_base/KeyRate/")
    rows = re.findall(r"<td>(\d\d\.\d\d\.\d{4})</td>\s*<td>([\d,]+)</td>", body.decode("utf-8", "replace"))
    day, rate = rows[0]
    value = float(rate.replace(",", "."))
    return {"answer": f"{rate} % (на {day})", "ref": {"number": value, "tol": 0.001}}


def cbr_rate(code):
    body, _ = get("https://www.cbr.ru/scripts/XML_daily.asp")
    t = body.decode("cp1251", "replace")
    day = re.search(r'Date="([\d.]+)"', t).group(1)
    m = re.search(rf"<CharCode>{code}</CharCode><Nominal>(\d+)</Nominal><Name>[^<]*</Name><Value>([\d,]+)</Value>", t)
    nominal, value = int(m.group(1)), float(m.group(2).replace(",", "."))
    per_one = value / nominal
    # курс на сегодня меняется раз в день; ответ округляют до копейки или до десятой
    return {"answer": f"{per_one:.4f} ₽ за 1 {code} (курс на {day})", "ref": {"number": round(per_one, 4), "tol": 0.06}}


def node_lts():
    d = get_json("https://nodejs.org/dist/index.json")
    lts = next(x for x in d if x["lts"])
    major = lts["version"].lstrip("v").split(".")[0]
    return {"answer": f"{lts['version']} ({lts['lts']}, {lts['date']})",
            "ref": {"must": [rf"\bv?{major}(\.\d+){{0,2}}\b"], "any": [[rf"\bv?{major}\b.*lts", "lts.*\\b" + major + r"\b",
                                                                        lts["lts"].lower(), num_re(lts["version"].lstrip("v"))]]}}


def python():
    d = get_json("https://endoflife.date/api/python.json")
    latest = d[0]
    eol = next(x["eol"] for x in d if x["cycle"] == "3.10")
    y, m, day = eol.split("-")
    months = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября",
              "декабря"]
    en = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november",
          "december"]
    ru_m, en_m = months[int(m) - 1], en[int(m) - 1]
    return {"answer": f"последняя {latest['latest']} (ветка {latest['cycle']}); Python 3.10 поддерживался до {eol}",
            "ref": {"must": [num_re(latest["cycle"])],
                    "any": [[eol, f"{int(day)} {ru_m} {y}", f"{en_m} {int(day)},? {y}", f"{day}\\.{m}\\.{y}",
                             f"{ru_m[:-1]}\\w* {y}", f"{en_m} {y}"]]}}


def npm(pkg):
    v = get_json(f"https://registry.npmjs.org/{pkg}/latest")["version"]
    major_minor = ".".join(v.split(".")[:2])
    return {"answer": v, "ref": {"must": [rf"\b{re.escape(major_minor)}(\.\d+)?\b"]}}


def kernel_stable():
    v = get_json("https://www.kernel.org/releases.json")["latest_stable"]["version"]
    return {"answer": v, "ref": {"must": [rf"\b{re.escape(v)}\b"]}}


def resolve(key):
    name, _, arg = key.partition(":")
    fn = {"cbr_key_rate": cbr_key_rate, "cbr_rate": cbr_rate, "node_lts": node_lts, "python": python, "npm": npm,
          "kernel_stable": kernel_stable}[name]
    out = fn(arg) if arg else fn()
    out["fetched_at"] = dt.datetime.now().astimezone().isoformat(timespec="seconds")
    return out


if __name__ == "__main__":
    qs = json.load(open(sys.argv[1] if len(sys.argv) > 1 else __file__.replace("live.py", "questions.json"),
                        encoding="utf-8"))["questions"]
    for q in qs:
        if q.get("live"):
            try:
                print(q["id"], json.dumps(resolve(q["live"]), ensure_ascii=False))
            except Exception as e:
                print(q["id"], "ОШИБКА", e)
