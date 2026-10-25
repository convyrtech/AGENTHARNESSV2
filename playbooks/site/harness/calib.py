"""Калибровка судьи «Дизайна» на разметке владельца (research/28 §4.2): FPR, κ и стабильность на 30–40 готовых страницах.

Три шага, всё пишется в одну папку ВНЕ git (на листе — содержимое закрытого пайплайна и страницы клиентов):

  calib.py sheet --root /home/user --root /tmp/ab --out /home/user/calib [--limit 40] [--seed 28]
      Находит готовые страницы (<ws>/design/<page> с контакт-листами и собранной страницей), отбрасывает заглушки и
      копии одной и той же страницы, снимает каждую на 1440 и 390 и пишет sheet.html: один файл без сети, страницы
      под номерами в случайном порядке, без путей, моделей и ответов судьи. На каждой — те же 12 вопросов, что у судьи
      (judge_questions.py), «да»/«нет», и общий вопрос «показали бы клиенту как есть». Разметка сохраняется в браузере,
      кнопка «Скачать разметку» отдаёт labels.json. Номер → путь — в manifest.json рядом (владельцу его не показывать).
      --page <ws>/design/<page> вместо поиска — свой список (можно несколько).
  calib.py judge --out /home/user/calib --pipeline <design-pipeline> [--runs 2] [--model claude-opus-5-5]
      Судья (judge.py, раунд 1, вопросы «да/нет») по каждой странице листа --runs раз, каждый раз на свежей копии:
      оригинал не трогается, раунды не копятся. Ответы — в judge-runs.json; повторный запуск доделывает недостающее.
      --model можно повторить: каждая модель считается отдельно.
  calib.py score --out /home/user/calib [--labels labels.json] [--json]
      Судья против владельца по каждому вопросу и по вердикту: FPR — доля «да» судьи там, где владелец сказал «нет»
      (с 95 % интервалом Уилсона), ложная тревога — «нет» судьи при «да» владельца, κ Коэна с владельцем (по каждому
      прогону), стабильность — совпадение прогонов между собой. Цель §4.2: FPR ≤ 0,2, κ ≥ 0,5, вердикт совпадает
      в ≥ 9 из 10 повторов.
"""
import argparse, base64, hashlib, html, io, json, math, random, shutil, subprocess, sys, tempfile, time
from pathlib import Path
for _s in (sys.stdout, sys.stderr):  # Windows: под -I PYTHONUTF8 не действует, а вывод в трубу идёт в cp1252
    _s.reconfigure(encoding="utf-8", errors="replace")
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import judge_questions as Q  # noqa: E402

WIDTHS = (1440, 390)
MIN_BYTES = 4000              # заглушки e2e и тестов — сотни байт
SKIP = ("node_modules", "dp-tests-", "design-pipeline", "/bundle/", "/.git/")
DOCS = ("FACTS.md", "02-brand.md", "04-motion.md")
TARGET = {"fpr": 0.2, "kappa": 0.5, "stable": 0.9}


# ---------- поиск страниц ----------

def site_of(page):
    """Собранная страница: <ws>/site/<page>/index.html, иначе index.html в папке страницы."""
    for f in (page.parent.parent / "site" / page.name / "index.html", page / "index.html"):
        if f.is_file():
            return f
    return None


def finished(page):
    """Страница дошла до судьи: есть контакт-листы и собранная страница не заглушка."""
    f = site_of(page)
    return bool(f and f.stat().st_size >= MIN_BYTES and any((page / "artifacts" / "visual-gate").glob("contact-*.png")))


def find_pages(roots):
    seen, out = set(), []
    for root in roots:
        for vg in sorted(Path(root).glob("**/design/*/artifacts/visual-gate")):
            page = vg.parent.parent
            if any(s in page.as_posix() + "/" for s in SKIP) or not finished(page):
                continue
            digest = hashlib.sha256(site_of(page).read_bytes()).hexdigest()
            if digest in seen:      # одна страница, скопированная в несколько мест (A/B, архивы e2e)
                continue
            seen.add(digest)
            out.append(page.resolve())
    return out


def choose(pages, limit, seed):
    pages = sorted(pages)
    rnd = random.Random(seed)
    if len(pages) > limit:
        pages = rnd.sample(pages, limit)
    rnd.shuffle(pages)              # порядок на листе ничего не говорит о прогоне
    return pages


# ---------- снимки и лист ----------

def shoot(site, width, max_height=9000):
    """Страница целиком после того, как анимации отыграли: прокрутка до низа будит появления по прокрутке."""
    from playwright.sync_api import sync_playwright
    from PIL import Image
    with sync_playwright() as p:
        browser = p.chromium.launch()
        try:
            page = browser.new_page(viewport={"width": width, "height": 844 if width < 768 else 900})
            page.goto(site.as_uri(), wait_until="load")
            page.wait_for_timeout(1500)
            h = page.evaluate("() => document.documentElement.scrollHeight")
            for y in range(0, min(h, max_height), 600):
                page.evaluate(f"window.scrollTo(0, {y})")
                page.wait_for_timeout(120)
            page.evaluate("window.scrollTo(0, 0)")
            page.wait_for_timeout(1500)
            png = page.screenshot(full_page=True)
        finally:
            browser.close()
    im = Image.open(io.BytesIO(png)).convert("RGB")
    if im.height > max_height:
        im = im.crop((0, 0, im.width, max_height))
    if im.width > 1000:
        im = im.resize((1000, round(im.height * 1000 / im.width)), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=72, optimize=True)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()


def excerpt(page, name, limit=2500):
    f = page / name
    if not f.exists():
        return ""
    t = f.read_text(encoding="utf-8", errors="replace")
    return t if len(t) <= limit else t[:limit] + "\n…"


CSS = """
:root{--bg:#f6f5f2;--card:#fff;--ink:#1b1b1b;--mute:#666;--line:#ddd;--yes:#1f7a3a;--no:#b3261e;--acc:#2a5bd7}
@media (prefers-color-scheme:dark){:root{--bg:#141414;--card:#1e1e1e;--ink:#eee;--mute:#aaa;--line:#333;
--yes:#5cc77a;--no:#ff7b72;--acc:#7fa6ff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 system-ui,sans-serif}
header{position:sticky;top:0;z-index:5;background:var(--card);border-bottom:1px solid var(--line);padding:10px 16px;
display:flex;gap:12px;align-items:center;flex-wrap:wrap}header b{margin-right:auto}
button{font:inherit;border:1px solid var(--line);background:var(--card);color:var(--ink);border-radius:6px;
padding:5px 10px;cursor:pointer}button.on-yes{background:var(--yes);color:#fff;border-color:var(--yes)}
button.on-no{background:var(--no);color:#fff;border-color:var(--no)}button.primary{background:var(--acc);color:#fff;
border-color:var(--acc)}
main{max-width:1500px;margin:0 auto;padding:16px}
section.p{background:var(--card);border:1px solid var(--line);border-radius:10px;margin:0 0 24px;padding:16px}
section.p.done{border-color:var(--yes)}h2{margin:0 0 10px;font-size:18px}
.shots{display:grid;grid-template-columns:minmax(0,390px) minmax(0,1fr);gap:12px}
.shot{max-height:640px;overflow:auto;border:1px solid var(--line);border-radius:6px;background:#fff}
.shot img{display:block;width:100%}.cap{font-size:12px;color:var(--mute);margin:0 0 4px}
details{margin:10px 0}pre{white-space:pre-wrap;font-size:12px;background:var(--bg);padding:8px;border-radius:6px;
max-height:300px;overflow:auto}
ol.q{list-style:none;padding:0;margin:10px 0}ol.q li{display:grid;grid-template-columns:1fr auto;gap:8px;
padding:6px 0;border-top:1px solid var(--line);align-items:center}.qid{color:var(--mute);font-size:12px;margin-right:4px}
.row{display:flex;gap:6px;flex-wrap:wrap;align-items:center}textarea{width:100%;font:inherit;min-height:44px;
background:var(--bg);color:var(--ink);border:1px solid var(--line);border-radius:6px;padding:6px}
@media (max-width:760px){.shots{grid-template-columns:1fr}ol.q li{grid-template-columns:1fr}}
"""

JS = r"""
const KEY = "calib-" + SHEET; let st = {};
try { st = JSON.parse(localStorage.getItem(KEY) || "{}"); } catch (e) { st = {}; }
function save() { try { localStorage.setItem(KEY, JSON.stringify(st)); } catch (e) {} paint(); }
function rec(id) { return st[id] || (st[id] = {answers: {}, ship: null, note: ""}); }
function set(id, q, v) { const r = rec(id); if (q === "ship") r.ship = r.ship === v ? null : v;
  else if (r.answers[q] === v) delete r.answers[q]; else r.answers[q] = v; save(); }
function rest(id) { const r = rec(id); for (const q of QIDS) if (!(q in r.answers)) r.answers[q] = true; save(); }
function done(r) { return r && QIDS.every(q => q in r.answers) && r.ship !== null; }
function paint() {
  let n = 0;
  for (const id of PAGES) {
    const r = st[id] || {answers: {}}; const sec = document.getElementById(id); if (done(r)) n++;
    sec.classList.toggle("done", done(r));
    sec.querySelectorAll("button[data-q]").forEach(b => { const q = b.dataset.q, v = b.dataset.v === "1";
      const cur = q === "ship" ? r.ship : r.answers[q];
      b.className = cur === v ? (v ? "on-yes" : "on-no") : ""; });
    const t = sec.querySelector("textarea"); if (document.activeElement !== t) t.value = r.note || "";
  }
  document.getElementById("progress").textContent = "Готово " + n + " из " + PAGES.length;
}
document.addEventListener("click", e => { const b = e.target.closest("button"); if (!b) return;
  const sec = b.closest("section.p");
  if (b.dataset.q) set(sec.id, b.dataset.q, b.dataset.v === "1");
  else if (b.dataset.act === "rest") rest(sec.id); });
document.addEventListener("input", e => { if (e.target.tagName === "TEXTAREA") {
  rec(e.target.closest("section.p").id).note = e.target.value; save(); } });
function exportJson() {
  const out = {sheet: SHEET, exported: new Date().toISOString(), questions: QIDS, pages: st};
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(out, null, 1)], {type: "application/json"}));
  a.download = "labels.json"; document.body.appendChild(a); a.click(); a.remove();
}
function importJson(f) { f.text().then(t => { const j = JSON.parse(t);
  if (j.sheet !== SHEET && !confirm("Файл от другого листа. Всё равно загрузить?")) return;
  st = j.pages || {}; save(); }); }
paint();
"""


def render(items, sheet_id):
    """items: [{"id", "shots": {1440: uri, 390: uri}, "docs": {name: text}}]."""
    def yn(q):
        return (f'<span class="row"><button data-q="{q}" data-v="1">да</button>'
                f'<button data-q="{q}" data-v="0">нет</button></span>')

    secs = []
    for n, it in enumerate(items, 1):
        docs = "".join(f"<details><summary>{html.escape(k)}</summary><pre>{html.escape(v)}</pre></details>"
                       for k, v in it["docs"].items() if v)
        qs = "".join(f'<li><span><span class="qid">{q}</span>{html.escape(text)}</span>{yn(q)}</li>'
                     for q, text, _sev, _src in Q.QUESTIONS)
        secs.append(
            f'<section class="p" id="{it["id"]}"><h2>Страница {n} из {len(items)}</h2>'
            f'<div class="shots"><div><p class="cap">Телефон, 390</p><div class="shot"><img loading="lazy" alt="390" '
            f'src="{it["shots"][390]}"></div></div><div><p class="cap">Компьютер, 1440</p><div class="shot">'
            f'<img loading="lazy" alt="1440" src="{it["shots"][1440]}"></div></div></div>'
            f'{docs}<ol class="q">{qs}<li><span><b>Показали бы клиенту как есть?</b></span>{yn("ship")}</li></ol>'
            f'<div class="row"><button data-act="rest">Остальное — «да»</button></div>'
            f'<p class="cap">Заметка (необязательно)</p><textarea></textarea></section>')
    head = ('<header><b>Разметка страниц</b><span id="progress"></span>'
            '<button class="primary" onclick="exportJson()">Скачать разметку</button>'
            '<label><button onclick="this.nextElementSibling.click()">Загрузить</button>'
            '<input type="file" accept=".json" hidden onchange="importJson(this.files[0])"></label></header>')
    intro = ("<p>Смотрите на страницу как владелец бизнеса. На каждый вопрос — «да» или «нет»; «нет» — если видите "
             "проблему или не можете убедиться по снимку. Обычно быстрее отметить «нет» там, где плохо, и нажать "
             "«Остальное — «да»». Числа и бренд сверяйте с FACTS.md и 02-brand.md под снимками. Разметка "
             "сохраняется в этом браузере; в конце нажмите «Скачать разметку» и пришлите labels.json.</p>")
    data = (f"const SHEET={json.dumps(sheet_id)};const QIDS={json.dumps(Q.IDS)};"
            f"const PAGES={json.dumps([it['id'] for it in items])};")
    return ('<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" '
            'content="width=device-width,initial-scale=1"><title>Разметка страниц</title>'
            f'<style>{CSS}</style></head><body>{head}<main>{intro}{"".join(secs)}</main>'
            f'<script>{data}{JS}</script></body></html>')


def cmd_sheet(a):
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    pages = [Path(p).resolve() for p in a.page] if a.page else find_pages(a.root)
    pages = choose([p for p in pages if finished(p)], a.limit, a.seed)
    if not pages:
        sys.exit("calib sheet: готовых страниц не нашлось (нужны design/<page>/artifacts/visual-gate/contact-*.png "
                 "и собранная страница)")
    sheet_id = hashlib.sha256("\n".join(map(str, pages)).encode()).hexdigest()[:12]
    items, manifest = [], {"sheet": sheet_id, "pages": {}}
    for i, page in enumerate(pages, 1):
        pid = f"p{i:02d}"
        site = site_of(page)
        print(f"{pid} {page}", file=sys.stderr)
        items.append({"id": pid, "shots": {w: shoot(site, w) for w in WIDTHS},
                      "docs": {d: excerpt(page, d) for d in DOCS}})
        manifest["pages"][pid] = {"page": str(page), "site": str(site)}
    (out / "sheet.html").write_text(render(items, sheet_id), encoding="utf-8")
    (out / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps({"sheet": str(out / "sheet.html"), "pages": len(items),
                      "mb": round((out / "sheet.html").stat().st_size / 1e6, 1)}, ensure_ascii=False))


# ---------- прогоны судьи ----------

def judge_once(page, pipeline, model, a):
    """Раунд 1 судьи на свежей копии <tmp>/design/<page> (+ site/<page>, canon): ответы на 12 вопросов и вердикт."""
    root = page.parent.parent
    tmp = Path(tempfile.mkdtemp(prefix="calib-judge-"))
    try:
        copy = tmp / "design" / page.name
        # copy2 сохраняет время файлов: контакт-листы остаются новее кода, как в записи
        shutil.copytree(page, copy, copy_function=shutil.copy2, ignore=shutil.ignore_patterns("judge"))
        site = root / "site" / page.name
        if site.is_dir():
            shutil.copytree(site, tmp / "site" / page.name, copy_function=shutil.copy2)
        if (root / "canon").is_dir():
            shutil.copytree(root / "canon", tmp / "canon", copy_function=shutil.copy2)
        t0 = time.time()
        r = subprocess.run([a.py or sys.executable, "-I", str(HERE / "judge.py"), "--page", str(copy),
                            "--transcripts", str(tmp / "state"), "--pipeline", str(pipeline), "--proxy", a.proxy,
                            "--model", model, "--max-rounds", "1", "--max-images", str(a.max_images)],
                           capture_output=True, text=True, encoding="utf-8")
        line = (r.stdout.strip().splitlines() or [""])[-1]
        try:
            info = json.loads(line) if r.returncode == 0 else None
        except ValueError:
            info = None
        if info is None:
            return {"error": (r.stdout + r.stderr).strip()[-300:], "exit": r.returncode}
        qa_f = tmp / "state" / "judge-questions.json"
        qa = next(iter(json.loads(qa_f.read_text(encoding="utf-8")).values()), {}) if qa_f.exists() else {}
        return {"answers": {q: bool(qa.get(q, {}).get("yes")) for q in Q.IDS},
                "reasons": {q: qa.get(q, {}).get("reason", "") for q in Q.IDS},
                "verdict": info.get("verdict"), "findings": info.get("findings"), "cost": info.get("cost"),
                "seconds": round(time.time() - t0)}
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def cmd_judge(a):
    out = Path(a.out)
    man = json.loads((out / "manifest.json").read_text(encoding="utf-8"))
    runs_f = out / "judge-runs.json"
    runs = json.loads(runs_f.read_text(encoding="utf-8")) if runs_f.exists() else {}
    for model in a.model or ["claude-opus-5-5"]:
        for pid, m in man["pages"].items():
            page = Path(m["page"])
            pipeline = Path(a.pipeline) if a.pipeline else page.parent.parent / "design-pipeline"
            have = runs.setdefault(model, {}).setdefault(pid, [])
            have[:] = [x for x in have if "answers" in x]      # упавшие прогоны переделываем
            while len(have) < a.runs:
                res = judge_once(page, pipeline, model, a)
                print(f"{model} {pid} прогон {len(have) + 1}: " +
                      ((res.get("verdict") or "?") if "answers" in res else "ошибка " + res["error"][-120:]),
                      file=sys.stderr)
                if "answers" not in res:
                    break
                have.append(res)
                runs_f.write_text(json.dumps(runs, ensure_ascii=False, indent=1), encoding="utf-8")
    runs_f.write_text(json.dumps(runs, ensure_ascii=False, indent=1), encoding="utf-8")
    short = sum(1 for mm in runs.values() for v in mm.values() if len(v) < a.runs)
    print(json.dumps({"runs": str(runs_f), "incomplete": short}, ensure_ascii=False))


# ---------- счёт ----------

def kappa(x, y):
    """κ Коэна для двух рядов булевых ответов; None, если ряд пуст или оба ряда постоянны и совпадают."""
    n = len(x)
    if not n:
        return None
    po = sum(1 for a, b in zip(x, y) if a == b) / n
    px, py = sum(x) / n, sum(y) / n
    pe = px * py + (1 - px) * (1 - py)
    return None if pe >= 1 else round((po - pe) / (1 - pe), 3)


def wilson(k, n, z=1.96):
    if not n:
        return None
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return [round(max(0.0, c - h), 3), round(min(1.0, c + h), 3)]


def compare(owner, runs):
    """owner: [bool]; runs: [[bool] на каждый прогон] той же длины. Судья — первый прогон и каждый по отдельности."""
    out = {"n": len(owner), "owner_no": sum(1 for o in owner if not o)}
    if not owner or not runs:
        return out
    j = runs[0]
    neg = [i for i, o in enumerate(owner) if not o]
    pos = [i for i, o in enumerate(owner) if o]
    fp = sum(1 for i in neg if j[i])
    out["fpr"] = round(fp / len(neg), 3) if neg else None
    out["fpr_ci"] = wilson(fp, len(neg))
    out["false_alarm"] = round(sum(1 for i in pos if not j[i]) / len(pos), 3) if pos else None
    out["kappa"] = [kappa(owner, r) for r in runs]
    if len(runs) > 1:
        same = [all(r[i] == runs[0][i] for r in runs) for i in range(len(owner))]
        out["stable"] = round(sum(same) / len(same), 3)
        out["kappa_runs"] = kappa(runs[0], runs[1])
    return out


def verdict_yes(run):
    return (run.get("verdict") or "").upper() == "PASS"


def score(labels, runs):
    lab = labels.get("pages") or {}
    report = {}
    for model, by_page in runs.items():
        k = min((len(v) for v in by_page.values() if v), default=0)
        ids = [p for p in sorted(by_page) if p in lab and len(by_page[p]) >= k > 0]
        res = {"pages": len(ids), "runs": k, "questions": {}}
        pooled_o, pooled_r = [], [[] for _ in range(k)]
        for q in Q.IDS:
            got = [p for p in ids if q in (lab[p].get("answers") or {})]
            o = [bool(lab[p]["answers"][q]) for p in got]
            rr = [[by_page[p][r]["answers"][q] for p in got] for r in range(k)]
            res["questions"][q] = compare(o, rr)
            pooled_o += o
            for r in range(k):
                pooled_r[r] += rr[r]
        res["all_questions"] = compare(pooled_o, pooled_r)
        got = [p for p in ids if lab[p].get("ship") is not None]
        res["verdict"] = compare([bool(lab[p]["ship"]) for p in got],
                                 [[verdict_yes(by_page[p][r]) for p in got] for r in range(k)])
        a = res["all_questions"]
        v = res["verdict"]
        res["targets"] = {"fpr<=0.2": None if a.get("fpr") is None else a["fpr"] <= TARGET["fpr"],
                          "kappa>=0.5": None if not a.get("kappa") or a["kappa"][0] is None
                          else min(x for x in a["kappa"] if x is not None) >= TARGET["kappa"],
                          "verdict_stable>=0.9": None if v.get("stable") is None else v["stable"] >= TARGET["stable"]}
        report[model] = res
    return report


def fmt(x):
    if x is None:
        return "—"
    if isinstance(x, list):
        return "/".join(fmt(v) for v in x)
    return f"{x:.2f}" if isinstance(x, float) else str(x)


def table(report):
    lines = []
    for model, res in report.items():
        lines.append(f"\n{model}: страниц {res['pages']}, прогонов {res['runs']}")
        lines.append(f"{'':5} {'n':>3} {'нет':>4} {'FPR':>5} {'95%':>11} {'ложн.тр':>7} {'κ':>11} {'стаб':>5}")
        rows = [(q, res["questions"][q]) for q in Q.IDS] + [("все", res["all_questions"]), ("верд", res["verdict"])]
        for name, r in rows:
            lines.append(f"{name:5} {r['n']:>3} {r['owner_no']:>4} {fmt(r.get('fpr')):>5} {fmt(r.get('fpr_ci')):>11} "
                         f"{fmt(r.get('false_alarm')):>7} {fmt(r.get('kappa')):>11} {fmt(r.get('stable')):>5}")
        lines.append("цели §4.2: " + ", ".join(f"{k} {'да' if v else '—' if v is None else 'нет'}"
                                               for k, v in res["targets"].items()))
    return "\n".join(lines)


def cmd_score(a):
    out = Path(a.out)
    labels = json.loads(Path(a.labels or out / "labels.json").read_text(encoding="utf-8"))
    runs = json.loads((out / "judge-runs.json").read_text(encoding="utf-8"))
    man_f = out / "manifest.json"
    if man_f.exists() and labels.get("sheet") not in (None, json.loads(man_f.read_text(encoding="utf-8"))["sheet"]):
        sys.exit("calib score: labels.json от другого листа")
    report = score(labels, runs)
    (out / "score.json").write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False) if a.json else table(report))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("sheet")
    s.add_argument("--root", action="append", default=[])
    s.add_argument("--page", action="append", default=[])
    s.add_argument("--out", required=True)
    s.add_argument("--limit", type=int, default=40)
    s.add_argument("--seed", type=int, default=28)
    j = sub.add_parser("judge")
    j.add_argument("--out", required=True)
    j.add_argument("--pipeline")
    j.add_argument("--proxy", default="http://127.0.0.1:8787")
    j.add_argument("--model", action="append")
    j.add_argument("--runs", type=int, default=2)
    j.add_argument("--max-images", type=int, default=3)
    j.add_argument("--py", help="python для judge.py (с PIL и Playwright); по умолчанию этот")
    c = sub.add_parser("score")
    c.add_argument("--out", required=True)
    c.add_argument("--labels")
    c.add_argument("--json", action="store_true")
    a = ap.parse_args(argv)
    if a.cmd == "sheet" and not (a.root or a.page):
        ap.error("sheet: нужен --root или --page")
    {"sheet": cmd_sheet, "judge": cmd_judge, "score": cmd_score}[a.cmd](a)


if __name__ == "__main__":
    main()
