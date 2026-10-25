"""Судья страницы, которого запускает харнесс, а не агент (research/16: судья и лимит раундов в коде).

Зачем: в E8 агент сам звал судью и тратил на это часы: падали вызовы, менялись модели, отчёт переписывался руками
(E8p: 14 файлов попыток в artifacts/judge/). А flow.py сверяет судью только по переписке Claude Code, которой у Pi нет,
и пропускал непроверенного судью с предупреждением.

Что делает:
  - берёт тело templates/JUDGE-PROMPT.md от строки «JUDGE-PROMPT v2», контакт-листы страницы, полосы движения,
    лист канона, 02-brand.md, 04-motion.md, MESSAGE.md; кода судья не видит;
  - не судит старые снимки: контакт-листы должны быть новее последней правки кода (иначе выход 4);
  - зовёт сильную модель через прокси надёжности потоком; ответ проверяет по правилам flow.py (вердикт, раунд,
    «Где» у каждой находки, раздел «не проверила») и один раз просит поправить формат;
  - пишет ответ дословно в artifacts/judge/JUDGE.md и запись в формате переписки Claude Code (вызов Agent с меткой
    и путями снимков + его результат) в папку харнесса; её flow.py читает через FLOW_TRANSCRIPTS;
  - считает раунды в той же папке; после --max-rounds отказывает (выход 3): дальше решает владелец;
  - после свободного разбора судья отвечает на 12 вопросов «да/нет» (judge_questions.py, research/20 §9); вердикт
    считает код: PASS, если все «да» или одно «нет» уровня Minor и нет открытых Blocker/Critical. Раунд 2+
    перепроверяет только прошлые «нет» и новых находок не ищет, кроме Blocker. --questions off — прежний судья (A/B).

  judge.py --page <ws>/design/<page> --transcripts <папка харнесса> [--pipeline <ws>/design-pipeline]
           [--proxy http://127.0.0.1:8787] [--model claude-opus-5-5] [--max-rounds 3] [--questions on|off]
Выход: 0 отчёт записан; 1 ошибка модели; 3 лимит раундов; 4 снимки старше кода (сначала gate.py).
"""
import argparse, base64, datetime as dt, hashlib, io, json, re, sys, time, urllib.request, uuid
from pathlib import Path
for _s in (sys.stdout, sys.stderr):  # Windows: под -I PYTHONUTF8 не действует, а вывод в трубу идёт в cp1252
    _s.reconfigure(encoding="utf-8", errors="replace")

ap = argparse.ArgumentParser()
ap.add_argument("--page", required=True)
ap.add_argument("--transcripts", required=True, help="папка харнесса для записи переписки судьи и счётчика раундов")
ap.add_argument("--pipeline", help="копия design-pipeline (по умолчанию <корень проекта>/design-pipeline)")
ap.add_argument("--proxy", default="http://127.0.0.1:8787")
ap.add_argument("--model", default="claude-opus-5-5")
ap.add_argument("--max-rounds", type=int, default=3)
ap.add_argument("--max-images", type=int, default=3)
ap.add_argument("--questions", choices=["on", "off"], default="on", help="вопросы «да/нет» и вердикт кодом")
a = ap.parse_args()
sys.path.insert(0, str(Path(__file__).resolve().parent))
import judge_questions as Q  # noqa: E402

page = Path(a.page).resolve()
root = page.parent.parent if page.parent.name == "design" else page.parent
pipe = Path(a.pipeline).resolve() if a.pipeline else root / "design-pipeline"
sys.path.insert(0, str(pipe / "tools"))
import flow as F  # noqa: E402

tdir = Path(a.transcripts).resolve()
tdir.mkdir(parents=True, exist_ok=True)
rounds_f = tdir / "judge-rounds.json"
rounds = json.loads(rounds_f.read_text(encoding="utf-8")) if rounds_f.exists() else {}
n = rounds.get(str(page), 0) + 1
qa_f = tdir / "judge-questions.json"
qa_all = json.loads(qa_f.read_text(encoding="utf-8")) if qa_f.exists() else {}
qa_prev = qa_all.get(str(page)) if n > 1 else None
asked = [q for q in Q.IDS if not (qa_prev or {}).get(q, {}).get("yes")] if a.questions == "on" else []
if n > a.max_rounds:
    print(f"judge: лимит {a.max_rounds} раунда исчерпан. Покажи владельцу страницу и открытые находки одним "
          f"сообщением, решает он.")
    sys.exit(3)

# снимки не старше кода: судья смотрит ту версию, которую увидит владелец
p = F.Page(page, str(tdir))
newest = F.newest_mtime(F.source_files(p.root, p.f("Исходники")))
vg = page / "artifacts" / "visual-gate"
sheets = sorted(vg.glob("contact-*.png"))
if not sheets:
    print("judge: нет контакт-листов artifacts/visual-gate/contact-*.png: сначала gate.py")
    sys.exit(4)
stale = [s.name for s in sheets if s.stat().st_mtime < newest]
if stale:
    print(f"judge: контакт-листы старше последней правки кода ({', '.join(stale[:3])}): сначала перезапусти gate.py")
    sys.exit(4)


def pick(paths, want):
    """Телефон и компьютер в одном движке плюс телефон в другом: этого судье хватает, остальное дублирует."""
    out = []
    for key in want:
        out += [x for x in paths if key in x.name and x not in out][:1]
    return out or paths


shots = pick(sheets, ["chromium-390", "chromium-1440", "webkit-390", "chromium-360", "webkit-1440"])[:3]
shots += sorted(x for x in page.glob("artifacts/motion*/**/*strip*.png"))[:2]
canon = [d for d in (root / "canon", page / "canon") if d.is_dir()]
canon_imgs = [x for d in canon for x in sorted(d.iterdir()) if x.suffix.lower() in (".png", ".jpg", ".jpeg", ".webp")]
shots += canon_imgs[:1]
shots = shots[:a.max_images]

tpl = (pipe / "templates" / "JUDGE-PROMPT.md").read_text(encoding="utf-8")
body = tpl[tpl.index(F.JUDGE_MARK):]


def doc(name):
    f = page / name
    return f"\n\n### {name}\n" + (f.read_text(encoding="utf-8")[:12000] if f.exists() else "(нет файла)")


prev = page / "artifacts" / "judge" / "JUDGE.md"
prompt = (body + f"\n\nЭто раунд {n}. В ответе строка «РАУНД: {n}»." +
          ("" if canon_imgs else " Листа канона нет: строку «КАНОН» не пиши.") +
          "\n\nСнимки (картинки приложены в этом порядке):\n" + "\n".join(f"- {s}" for s in shots) +
          doc("02-brand.md") + doc("04-motion.md") + doc("MESSAGE.md") + doc("FACTS.md"))
if n > 1 and prev.exists():
    prompt += ("\n\n### Твой прошлый отчёт (колонку «Статус» правил исполнитель)\n" + prev.read_text(encoding="utf-8")[:12000] +
               ("\n\nПроверь по новым снимкам, что из прошлых находок исправлено на самом деле. Новых находок не ищи, "
                "кроме Blocker." if a.questions == "on" else
                "\n\nПроверь по новым снимкам, что из прошлых находок исправлено на самом деле, и ищи новое."))
if a.questions == "on":
    prompt += Q.block_prompt(n, qa_prev)


def img_part(path):
    from PIL import Image
    im = Image.open(path).convert("RGB")
    k = 1568 / max(im.size)
    if k < 1:
        im = im.resize((int(im.width * k), int(im.height * k)), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, "PNG", optimize=True)
    return {"type": "image_url", "image_url": {"url": "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()}}


content = [{"type": "text", "text": prompt}]
for s in shots:
    content += [{"type": "text", "text": f"Снимок: {s.name}"}, img_part(s)]


def call(messages):
    req = urllib.request.Request(a.proxy.rstrip("/") + "/v1/chat/completions",
                                 data=json.dumps({"model": a.model, "max_tokens": 16000, "stream": True,
                                                  "messages": messages}).encode(),
                                 headers={"Content-Type": "application/json", "Authorization": "Bearer local"})
    out, usage = [], {}
    with urllib.request.urlopen(req, timeout=900) as r:
        for raw in r:
            s = raw.decode("utf-8", "replace").strip()
            if not s.startswith("data:") or s == "data: [DONE]":
                continue
            try:
                j = json.loads(s[5:])
            except ValueError:
                continue
            if j.get("error"):
                raise RuntimeError(str(j["error"])[:200])
            for ch in j.get("choices") or []:
                out.append((ch.get("delta") or {}).get("content") or "")
            usage = j.get("usage") or usage
    return "".join(out), usage


def clean(text):
    t = text.strip()
    m = re.fullmatch(r"```[a-zA-Z]*\n(.*)\n```", t, re.S)
    return (m.group(1) if m else t).strip() + "\n"


def problems(text):
    pr = []
    if not re.search(r"(?m)^\s*JUDGE-VERDICT\s*:\s*(PASS|FAIL)\b", text):
        pr.append("первой строкой «JUDGE-VERDICT: PASS» или «JUDGE-VERDICT: FAIL»")
    rd = re.search(r"(?m)^\s*РАУНД\s*:\s*(\d+)", text)
    if not rd or int(rd.group(1)) != n:
        pr.append(f"строка «РАУНД: {n}»")
    if canon_imgs and not re.search(r"(?m)^\s*КАНОН\s*:\s*\d+\s*/\s*10", text):
        pr.append("строка «КАНОН: N/10»")
    rows, _ = F.judge_lines(text)
    bad = [r for r, where in rows if not F.WHERE.search(where or "")]
    if bad:
        pr.append(f"в колонке «Где» у каждой находки селектор или регион (`main > h2`, «390, y=1200»); без него: «{bad[0][:60]}»")
    if not F.meaningful(F.section(text, r"не провер") or ""):
        pr.append("раздел «## Что я НЕ проверила» со строками «- …»")
    if asked:
        miss = Q.missing(Q.parse(text), asked)
        if miss:
            pr.append(f"раздел «{Q.HEADING}»: строка «Qn ДА|НЕТ — причина» внутри ``` для {', '.join(miss)}")
    return pr


t0 = time.time()
messages = [{"role": "user", "content": content}]
answer, usage, err = "", {}, None
for attempt in range(3):
    try:
        raw, usage = call(messages)
    except Exception as e:                      # прокси уже повторил 3 раза; ещё одна попытка целиком
        err = repr(e)[:200]
        continue
    if not raw.strip():
        err = "пустой ответ"
        continue
    answer = clean(raw)
    pr = problems(answer)
    if not pr:
        break
    messages = [{"role": "user", "content": content}, {"role": "assistant", "content": raw},
                {"role": "user", "content": "Перепиши ответ целиком в формате из задания, ничего не меняя по сути. "
                                            "Не хватает: " + "; ".join(pr) + "."}]
if not answer:
    print(f"judge: модель не ответила ({err})")
    sys.exit(1)
model_verdict = re.search(r"(?m)^\s*JUDGE-VERDICT\s*:\s*(\w+)", answer)
model_verdict = model_verdict.group(1) if model_verdict else None
qa, no = None, []
if a.questions == "on":
    # вердикт — кодом: прошлые «да» остаются, неотвеченное — «нет», открытые Blocker/Critical держат FAIL
    qa = Q.merge(qa_prev, Q.parse(answer), n)
    rows, _ = F.judge_lines(answer)
    blockers = sum(1 for r, _w in rows if re.match(r"\s*\**\s*(blocker|critical)", r, re.I))
    final, no = Q.verdict(qa, blockers)
    answer = Q.apply(answer, qa, final)

now = dt.datetime.now(dt.timezone.utc)
iso = now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z"
jd = page / "artifacts" / "judge"
jd.mkdir(parents=True, exist_ok=True)
(jd / f"ROUND-{n}.md").write_text(answer, encoding="utf-8")
(jd / "JUDGE.md").write_text(answer, encoding="utf-8")
# запись в формате переписки Claude Code: flow.py принимает только ответ подагента на вызов с меткой и путями снимков
tid = "toolu_harness_" + uuid.uuid4().hex[:20]
recs = [{"type": "assistant", "uuid": str(uuid.uuid4()), "timestamp": iso, "harness": "judge.py",
         "message": {"role": "assistant", "model": a.model,
                     "content": [{"type": "tool_use", "id": tid, "name": "Agent",
                                  "input": {"description": f"судья, раунд {n}", "prompt": prompt}}]}},
        {"type": "user", "uuid": str(uuid.uuid4()), "timestamp": iso, "harness": "judge.py",
         "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": tid,
                                                  "content": [{"type": "text", "text": answer}]}]}}]
tf = tdir / "judge.jsonl"
with open(tf, "a", encoding="utf-8") as f:
    for r in recs:
        f.write(json.dumps(r, ensure_ascii=False) + "\n")
rounds[str(page)] = n
rounds_f.write_text(json.dumps(rounds, ensure_ascii=False, indent=1), encoding="utf-8")
if qa is not None:
    qa_all[str(page)] = qa
    qa_f.write_text(json.dumps(qa_all, ensure_ascii=False, indent=1), encoding="utf-8")
# отпечаток переписки: харнесс сверяет его перед каждым запуском flow, правку руками видно
(tdir / "judge.sha256").write_text(hashlib.sha256(tf.read_bytes()).hexdigest(), encoding="utf-8")
verdict = re.search(r"(?m)^\s*JUDGE-VERDICT\s*:\s*(\w+)", answer)
rows, _ = F.judge_lines(answer)
sev = {}
for r, _w in rows:
    k = (r.split() or ["?"])[0].strip("*").capitalize()
    sev[k] = sev.get(k, 0) + 1
print(json.dumps({"round": n, "verdict": verdict.group(1) if verdict else None, "model_verdict": model_verdict,
                  "yes": None if qa is None else sum(1 for q in Q.IDS if qa[q]["yes"]), "no": no,
                  "asked": asked, "cost": (usage.get("cost") or {}).get("total") if isinstance(usage.get("cost"), dict)
                  else usage.get("cost"), "findings": sev,
                  "images": [s.name for s in shots], "seconds": round(time.time() - t0),
                  "prompt_tokens": usage.get("prompt_tokens"), "completion_tokens": usage.get("completion_tokens"),
                  "format_problems": problems(answer)}, ensure_ascii=False))
sys.exit(0)
