"""Дирижёр плейбука «страница сайта»: план в коде, свежая сессия Pi на каждый шаг, передача через файлы (research/16).

Зачем: в E8 одна длинная сессия вела весь пайплайн, контекст рос до сотен тысяч токенов, каждый вызов ждал 8–14 с до
первого токена, агент сам звал судью и сам решал, когда показывать владельцу. Здесь шаг выбирает flow.py, модель и
бюджет — stages.json, судью зовёт харнесс, второе мнение стоит перед каждым сообщением владельцу.

  run.py init <ws> --page <имя> [--materials <папка>]   завести рабочую папку
  run.py say  <ws> "<текст владельца>" [--files f ...]   сообщение владельца → шаги до следующего вопроса
  run.py status <ws>                                     где мы, сколько потрачено

Вывод `say` — события JSONL в stdout (их читает вкладка «Дизайн» приложения):
  {"ev":"stage","gate":"2","title":…,"model":…,"attempt":1}   {"ev":"tool","name":…,"brief":…}
  {"ev":"note","text":…}   {"ev":"owner","text":…,"files":[…],"options":[…]}   {"ev":"done"}   {"ev":"stuck","text":…}
"""
import argparse, datetime as dt, hashlib, json, os, re, shutil, subprocess, sys, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
PLAYBOOK = HERE.parent                                  # playbooks/site
CFG = json.loads((HERE / "stages.json").read_text(encoding="utf-8"))
PY = sys.executable
# PI_BIN: "pi" или JSON-список, например ["C:\\PRSLOY\\node.exe", "C:\\PRSLOY\\pi\\cli.js"] в приложении
PI = json.loads(os.environ["PI_BIN"]) if os.environ.get("PI_BIN", "").startswith("[") else [os.environ.get("PI_BIN", "pi")]
PI[0] = shutil.which(PI[0]) or PI[0]
WIN = os.name == "nt"
SAFE = ("PATH", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SYSTEMROOT", "COMSPEC", "PATHEXT", "TEMP", "TMP",
        "LANG", "LC_ALL", "TERM", "TMPDIR", "PLAYWRIGHT_BROWSERS_PATH", "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD",
        "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy", "SSL_CERT_FILE",
        "REQUESTS_CA_BUNDLE", "NODE_EXTRA_CA_CERTS", "CURL_CA_BUNDLE", "PI_CODING_AGENT_DIR")
SHIMS = ("claude", "codex", "gemini", "aider", "cursor-agent", "opencode", "qwen", "kimi")
ENDS_OK = "ЭТАП ГОТОВ"
TO_OWNER = "ВЛАДЕЛЬЦУ:"


def emit(**ev):
    ev["t"] = round(time.time(), 1)
    print(json.dumps(ev, ensure_ascii=False), flush=True)


class WS:
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.h = self.root / "harness"
        self.state_f = self.h / "state.json"
        self.state = json.loads(self.state_f.read_text(encoding="utf-8")) if self.state_f.exists() else {}

    @property
    def page(self):
        return self.root / "design" / self.state["page"]

    @property
    def pipe(self):
        return self.root / "design-pipeline"

    def save(self):
        self.state_f.write_text(json.dumps(self.state, ensure_ascii=False, indent=1), encoding="utf-8")

    def ledger(self, **rec):
        rec["ts"] = round(time.time(), 1)
        with open(self.h / "ledger.jsonl", "a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")

    def env(self):
        env = {k: v for k, v in os.environ.items() if k in SAFE}
        env["PATH"] = str(self.h / "bin") + os.pathsep + env.get("PATH", "")
        env["FLOW_TRANSCRIPTS"] = str(self.h / "tx")
        return env


# ---------- init ----------
def init(a):
    ws = WS(a.ws)
    src = Path(a.pipeline or os.environ.get("DESIGN_PIPELINE", "")).resolve()
    if not (src / "tools" / "flow.py").exists():
        sys.exit("run.py init: нужна копия design-pipeline (--pipeline или DESIGN_PIPELINE)")
    ws.root.mkdir(parents=True, exist_ok=True)
    for d in ("harness/tx", "harness/sessions", "harness/bin", "owner", "materials", "design", "site"):
        (ws.root / d).mkdir(parents=True, exist_ok=True)
    if not ws.pipe.exists():
        shutil.copytree(src, ws.pipe, ignore=shutil.ignore_patterns(".git", "__pycache__", "examples"))
        patch = HERE / "pipeline-fixes.patch"
        if patch.exists():
            r = subprocess.run(["git", "apply", "--directory=design-pipeline", str(patch)], cwd=ws.root,
                               capture_output=True, text=True)
            if r.returncode:
                emit(ev="note", text="патч пайплайна не лёг: " + r.stderr[:200])
        shutil.copytree(PLAYBOOK / "motion", ws.pipe / "motion", ignore=shutil.ignore_patterns("sheets", "__pycache__"))
    cat = PLAYBOOK.parents[1] / "experiments" / "e8b" / "etalons"
    if cat.exists() and not (ws.root / "etalons").exists():
        shutil.copytree(cat, ws.root / "etalons", ignore=shutil.ignore_patterns("*.mp4", "frames*", "__pycache__"))
    shutil.copyfile(HERE / "AGENTS.md", ws.root / "AGENTS.md")
    for f in ("check.py", "second_opinion.py"):
        shutil.copyfile(HERE / f, ws.h / f)
    for name in SHIMS:                                   # чужие ИИ-программы первыми на PATH: блок в коде, не в промпте
        msg = "запрещено харнессом: другие ИИ-программы запускать нельзя (аккаунт и деньги владельца)"
        if WIN:
            (ws.h / "bin" / f"{name}.cmd").write_text(f"@echo {msg} 1>&2\r\n@exit /b 126\r\n", encoding="utf-8")
        else:
            p = ws.h / "bin" / name
            p.write_text(f'#!/bin/sh\necho "{msg}" >&2\nexit 126\n', encoding="utf-8")
            p.chmod(0o755)
    if a.materials:
        for f in Path(a.materials).iterdir():
            if f.is_file():
                shutil.copyfile(f, ws.root / "materials" / f.name)
    (ws.root / "owner" / "messages.jsonl").touch()
    ws.state.update(page=a.page, created=time.time(), turn=0, outbox=0)
    ws.save()
    flow(ws, "--init")
    st = ws.page / "STATUS.md"
    t = st.read_text(encoding="utf-8")
    known = {"Канал владельца": "owner/messages.jsonl", "Решения": "нет", "Расшифровки голоса": "нет",
             "Исходники": f"site/{a.page}/**", "Материалы владельца": "есть" if any((ws.root / "materials").iterdir()) else "ждём"}
    for k, v in known.items():
        t = re.sub(rf"(?m)^- {re.escape(k)}:.*$", f"- {k}: {v}", t)
    st.write_text(t, encoding="utf-8")
    print(json.dumps({"ws": str(ws.root), "page": a.page}, ensure_ascii=False))


# ---------- flow and checks ----------
def flow(ws, *extra):
    r = subprocess.run([PY, "-I", str(ws.pipe / "tools" / "flow.py"), "--page", str(ws.page), *extra],
                       cwd=ws.root, env=ws.env(), capture_output=True, text=True, encoding="utf-8")
    if "--json" in extra:
        try:
            return json.loads(r.stdout)
        except ValueError:
            return {"exit": 1, "next": {"gate": "?", "problems": [r.stdout[-400:] + r.stderr[-400:]]}}
    return r.stdout


def judge_intact(ws):
    """Переписку судьи пишет только judge.py; правка руками меняет отпечаток."""
    tf, sf = ws.h / "tx" / "judge.jsonl", ws.h / "tx" / "judge.sha256"
    if not tf.exists():
        return True
    return sf.exists() and hashlib.sha256(tf.read_bytes()).hexdigest() == sf.read_text().strip()


def harness_check(ws):
    site = ws.root / "site"
    if not any(site.rglob("*.html")):
        return ""
    r = subprocess.run([PY, "-I", str(ws.h / "check.py"), str(site), str(ws.page)], cwd=ws.root, capture_output=True,
                       text=True, encoding="utf-8")
    return r.stdout if r.returncode else ""


def run_judge(ws):
    r = subprocess.run([PY, "-I", str(HERE / "judge.py"), "--page", str(ws.page), "--transcripts", str(ws.h / "tx"),
                        "--pipeline", str(ws.pipe), "--model", CFG["judge"]["model"],
                        "--max-rounds", str(CFG["judge"]["max_rounds"])],
                       cwd=ws.root, capture_output=True, text=True, encoding="utf-8")
    ws.ledger(kind="judge", exit=r.returncode, out=r.stdout[-400:])
    return r.returncode, r.stdout.strip()


def second_opinion(ws, text, model, gate=""):
    fam = family(model)
    checker = next((m for m in CFG["ladder"] if family(m) != fam), CFG["ladder"][0]).split("/", 1)[1]
    mf = ws.h / f"msg-{ws.state['outbox'] + 1:02d}.txt"
    mf.write_text(text, encoding="utf-8")
    sent = [o for o in owner_messages(ws, limit=50)]
    known = "\n".join(f"- «{o.get('text')}»" + (f" + файлы: {', '.join(o['files'])}" if o.get("files") else "") for o in sent)
    r = subprocess.run([PY, "-I", str(ws.h / "second_opinion.py"), str(ws.root), str(mf), "--model", checker,
                        "--gate", gate, "--known", known[-3000:]],
                       capture_output=True, text=True, encoding="utf-8")
    try:
        op = json.loads(r.stdout)
    except ValueError:
        return None
    ws.ledger(kind="second_opinion", model=checker, verdict=op.get("verdict"))
    return op


def family(model):
    m = model.lower()
    return next((f for k, f in CFG["family"].items() if k in m), m)


# ---------- one stage session ----------
def section(md, head):
    m = re.search(rf"^## {re.escape(head)}.*?(?=^## |\Z)", md, re.M | re.S)
    return m.group(0).strip() if m else ""


def owner_messages(ws, since=0.0, limit=6):
    out = []
    for ln in (ws.root / "owner" / "messages.jsonl").read_text(encoding="utf-8").splitlines():
        try:
            o = json.loads(ln)
        except ValueError:
            continue
        out.append(o)
    return out[-limit:]


def brief(ws, gate, fl, cfg, notes):
    nx = fl.get("next") or {}
    pipe_md = (ws.pipe / "PIPELINE.md").read_text(encoding="utf-8")
    st = (ws.page / "STATUS.md").read_text(encoding="utf-8") if (ws.page / "STATUS.md").exists() else ""
    msgs = owner_messages(ws)
    files = sorted(str(p.relative_to(ws.page)) for p in ws.page.iterdir()) if ws.page.exists() else []
    lines = [
        f"[харнесс] Шаг {gate} «{nx.get('title', '')}» страницы design/{ws.state['page']}. Это отдельная сессия только "
        "для этого шага: прошлых разговоров ты не видишь, всё нужное лежит в файлах (STATUS.md, DECISIONS.md, "
        "артефакты страницы). Другие шаги сделают другие сессии.",
        "", "## Что говорит flow.py", f"Что сделать: {nx.get('do', '')}",
        *[f"- {p}" for p in nx.get("problems", [])[:12]],
        *([f"Шаблон: {nx['tpl']}"] if nx.get("tpl") else []), *([f"Команда: {nx['cmd']}"] if nx.get("cmd") else []),
        "", "## Шаг из PIPELINE.md", section(pipe_md, cfg.get("pipeline", f"Шаг {gate}.")) or "(см. design-pipeline/PIPELINE.md)",
    ]
    if cfg.get("note"):
        lines += ["", "## Правило харнесса для этого шага", cfg["note"]]
    if notes:
        lines += ["", "## Проверки харнесса (не владелец): исправь до показа владельцу", *notes]
    said = [f"- {o.get('date')}: «{o.get('text')}»" + (f" [файлы: {', '.join(o['files'])}]" if o.get("files") else "")
            for o in msgs] or ["- (пока нет)"]
    lines += ["", "## Последние сообщения владельца (дословно)", *said,
              "", "## STATUS.md сейчас", st[:4000], "", "## Файлы страницы", ", ".join(files)[:1500],
              "", "## Как закончить",
              f"- Шаг сделан и `python3 -I design-pipeline/tools/flow.py --page design/{ws.state['page']}` его пропускает: "
              f"последней строкой напиши «{ENDS_OK}».",
              f"- Для шага нужен ответ владельца (выбор по листу, «да», материалы): закончи сообщением ему. Первая строка "
              f"«{TO_OWNER}», дальше текст по design-pipeline/templates/OWNER-MESSAGE.md (до 5 строк, один вопрос, своя "
              "рекомендация, путь к картинке или видео). Больше ничего после него не пиши.",
              "- Владельцу пишешь только так. Строки ВЫБОР — только его слова из сообщений выше."]
    return "\n".join(lines)


def run_stage(ws, gate, prompt, model, cfg, session):
    """Одна сессия Pi с бюджетом и детекторами петель. Возвращает (final_text, stats)."""
    # задание идёт файлом (@file): длинный многострочный текст в командной строке ломается на Windows
    bf = session.with_name(session.stem + f"-{int(time.time())}.brief.md")
    bf.write_text(prompt, encoding="utf-8")
    args = [*PI, "--mode", "json", "--model", model, "--session", str(session), "@" + str(bf),
            "Выполни задание харнесса из файла выше."]
    t0 = time.time()
    st = {"calls": 0, "in": 0, "out": 0, "cached": 0, "cost": 0.0, "edits_since_check": 0, "killed": None}
    seen, final = {}, ""
    p = subprocess.Popen(args, cwd=ws.root, env=ws.env(), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                         stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace")
    log = open(session.with_suffix(".events.jsonl"), "a", encoding="utf-8")
    deadline = t0 + cfg["max_minutes"] * 60
    for ln in p.stdout:
        log.write(ln)
        if time.time() > deadline:
            st["killed"] = f"время шага вышло ({cfg['max_minutes']} мин)"
            break
        try:
            e = json.loads(ln)
        except ValueError:
            continue
        if e.get("type") != "message_end" or (e.get("message") or {}).get("role") != "assistant":
            continue
        m = e["message"]
        st["error"] = (m.get("errorMessage") or "")[:200] if m.get("stopReason") == "error" else None
        u = m.get("usage") or {}
        st["in"] += u.get("input", 0) or 0
        st["out"] += u.get("output", 0) or 0
        st["cached"] += u.get("cacheRead", 0) or 0
        st["cost"] += (u.get("cost") or {}).get("total", 0) or 0
        for b in m.get("content") or []:
            if b.get("type") == "text" and b.get("text"):
                final = b["text"]
            if b.get("type") != "toolCall":
                continue
            st["calls"] += 1
            argj = json.dumps(b.get("arguments"), ensure_ascii=False, sort_keys=True)
            sig = b.get("name", "") + argj
            seen[sig] = seen.get(sig, 0) + 1
            cmd = str((b.get("arguments") or {}).get("command", ""))
            if b.get("name") in ("edit", "write"):
                st["edits_since_check"] += 1
            if re.search(r"flow\.py|gate\.py|check\.py|visual_gate|check_motion", cmd):
                st["edits_since_check"] = 0
            emit(ev="tool", name=b.get("name"), brief=(cmd or argj)[:120])
            if seen[sig] >= cfg["same_call_limit"]:
                st["killed"] = f"петля: один и тот же вызов {seen[sig]} раза ({b.get('name')} {argj[:80]})"
            elif st["calls"] >= cfg["max_calls"]:
                st["killed"] = f"бюджет вызовов шага исчерпан ({cfg['max_calls']})"
        if st["killed"]:
            break
    if st["killed"]:
        if WIN:
            subprocess.run(["taskkill", "/T", "/F", "/PID", str(p.pid)], capture_output=True)
        else:
            p.kill()
    p.wait()
    log.close()
    st["seconds"] = round(time.time() - t0)
    return final.strip(), st


# ---------- say: owner message → stages until the next question ----------
def options_of(text):
    """Варианты для кнопок, сгруппированные по вопросам: [{"q": "Для кого страница?", "options": [{key, label}]}]."""
    groups, cur = [], None
    for ln in text.splitlines():
        q = re.match(r"^\s*\d+[.)]\s+(.+\?)\s*$", ln)
        o = re.match(r"^\s*([A-DА-Г])[.)]\s+(.{1,160})$", ln)
        if q:
            cur = {"q": q.group(1).strip(), "options": []}
            groups.append(cur)
        elif o:
            if cur is None:
                cur = {"q": "", "options": []}
                groups.append(cur)
            cur["options"].append({"key": o.group(1), "label": o.group(2).strip(),
                                   "recommended": "рекомендую" in o.group(2).lower()})
    return [g for g in groups if g["options"]][:3]


def say(a):
    ws = WS(a.ws)
    files = []
    for f in a.files or []:
        dst = ws.root / "materials" / Path(f).name
        shutil.copyfile(f, dst)
        files.append(f"materials/{dst.name}")
    if a.text:
        ws.state["turn"] = ws.state.get("turn", 0) + 1
        with open(ws.root / "owner" / "messages.jsonl", "a", encoding="utf-8") as f:
            f.write(json.dumps({"id": ws.state["turn"], "date": dt.datetime.now().strftime("%Y%m%d-%H%M%S"),
                                "text": a.text, "forward_from": None, "files": files}, ensure_ascii=False) + "\n")
        # ответ владельца: шаг, который ждал его, не провалился — попытки шага с нуля, ступень лестницы прежняя
        for h in ws.state.get("attempts", {}).values():
            if h.get("waiting_owner"):
                h.update(n=0, last=None, waiting_owner=False)
        ws.save()
    notes = list(ws.state.pop("carry_notes", []))
    ws.state["transport_errors"] = 0
    for _ in range(CFG["max_stages_per_turn"]):
        if not judge_intact(ws):
            emit(ev="stuck", text="переписку судьи меняли не через харнесс: результат судьи не принимается")
            return
        fl = flow(ws, "--json")
        if fl.get("exit") == 0:
            emit(ev="done", text="все шаги пройдены")
            return
        nx = fl.get("next") or {}
        gate = nx.get("gate", "?")
        cfg = {**CFG["defaults"], **CFG["stages"].get(gate, {})}
        probs = nx.get("problems", [])
        # судью зовёт харнесс: когда в шаге 7 не хватает только судьи
        if gate == "7" and probs and all("судь" in x for x in probs):
            code, out = run_judge(ws)
            emit(ev="note", text=f"судья: {out[-300:]}")
            if code == 0:
                continue
            if code == 3:
                notes = ["Лимит раундов судьи исчерпан. Покажи владельцу страницу и открытые находки JUDGE.md одним "
                         "сообщением, решает он."]
            elif code == 4:
                notes = ["Судья не смотрит старые снимки: перезапусти гейт (команда выше), потом «ЭТАП ГОТОВ»."]
            else:
                emit(ev="stuck", text="судья не ответил: " + out[-200:])
                return
        # попытки и лестница моделей по шагу
        key = f"g{gate}"
        hist = ws.state.setdefault("attempts", {}).setdefault(key, {"n": 0, "rung": cfg["start"], "last": None})
        if hist["last"] == probs and hist["n"] >= cfg["max_attempts"]:
            hist["rung"] += 1
            hist["n"] = 0
            ws.ledger(kind="escalate", gate=gate, to=hist["rung"], why=probs[:3])
        if hist["rung"] >= len(CFG["ladder"]):
            emit(ev="stuck", text=f"шаг {gate} не получился ни на одной модели лестницы: {probs[:3]}")
            ws.save()
            return
        model = CFG["ladder"][hist["rung"]]
        hist["n"] += 1
        hist["last"] = probs
        ws.save()
        sess = ws.h / "sessions" / f"{gate}-{int(time.time())}.jsonl"
        emit(ev="stage", gate=gate, title=nx.get("title"), model=model, attempt=hist["n"])
        final, st = run_stage(ws, gate, brief(ws, gate, fl, cfg, notes), model, cfg, sess)
        ws.ledger(kind="stage", gate=gate, model=model, attempt=hist["n"], **st,
                  end="owner" if TO_OWNER in final else ("ok" if ENDS_OK in final else "other"))
        notes = []
        if st.get("error") and not final:
            # обрыв у поставщика — не провал шага: та же ступень, попытка не считается (не больше 3 за ход)
            ws.state["transport_errors"] = ws.state.get("transport_errors", 0) + 1
            if ws.state["transport_errors"] <= 3:
                hist["n"] -= 1
                hist["last"] = None
            emit(ev="note", text="связь с моделью оборвалась, повторяю шаг: " + st["error"][:120])
        if st["killed"]:
            notes.append(f"Прошлая сессия этого шага остановлена харнессом: {st['killed']}. Не повторяй то же; "
                         "сначала запусти flow.py и сделай то, что он называет.")
        if st["edits_since_check"] >= cfg["edits_without_check"]:
            notes.append(f"Прошлая сессия сделала {st['edits_since_check']} правок без проверки. После правок запускай "
                         "flow.py и гейт.")
        hc = harness_check(ws)
        if hc:
            notes.append(hc.strip())
        if TO_OWNER in final:
            text = final.split(TO_OWNER, 1)[1].strip()
            if hc:                                           # проверка харнесса провалена: владельцу не показываем
                continue
            fails = 0
            while True:
                op = second_opinion(ws, text, model, gate)
                if not op or op.get("verdict") != "FAIL" or fails >= CFG["checker_retries"]:
                    break
                fails += 1
                bad = [i for i in op.get("items", []) if not i.get("ok")]
                fix = ("[второе мнение харнесса, не владелец: сообщение владельцу НЕ ушло. Исправь это в работе и в "
                       f"сообщении, потом снова закончи «{TO_OWNER}» и текстом]\n" +
                       "\n".join(f"- {i['check']}: {i['evidence']}" for i in bad))
                emit(ev="note", text="второе мнение вернуло сообщение: " + "; ".join(i["check"] for i in bad))
                f2, s2 = run_stage(ws, gate, fix, model, cfg, sess)
                ws.ledger(kind="fix", gate=gate, model=model, **s2)
                if TO_OWNER in f2:
                    text = f2.split(TO_OWNER, 1)[1].strip()
            hist["waiting_owner"] = True
            ws.state["outbox"] = ws.state.get("outbox", 0) + 1
            ob = ws.page / "outbox"
            ob.mkdir(exist_ok=True)
            (ob / f"{ws.state['outbox']:02d}.md").write_text(text + "\n", encoding="utf-8")
            shown = [str((ws.root / x).resolve()) for x in re.findall(r"[\w./\\-]+\.(?:png|jpe?g|mp4|webm|html)", text)
                     if (ws.root / x).exists()]
            ws.save()
            emit(ev="owner", text=text, files=shown, options=options_of(text))
            return
    ws.state["carry_notes"] = notes
    ws.save()
    emit(ev="note", text="на этот ход шагов хватит; продолжу по следующему сообщению")


def status(a):
    ws = WS(a.ws)
    fl = flow(ws, "--json")
    cost = calls = secs = 0
    led = ws.h / "ledger.jsonl"
    for ln in (led.read_text(encoding="utf-8").splitlines() if led.exists() else []):
        r = json.loads(ln)
        cost += r.get("cost", 0) or 0
        calls += r.get("calls", 0) or 0
        secs += r.get("seconds", 0) or 0
    print(json.dumps({"page": ws.state.get("page"), "done": fl.get("done"), "next": (fl.get("next") or {}).get("gate"),
                      "pi_cost_usd": round(cost, 4), "tool_calls": calls, "agent_minutes": round(secs / 60, 1)},
                     ensure_ascii=False))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    sp = ap.add_subparsers(dest="cmd", required=True)
    i = sp.add_parser("init"); i.add_argument("ws"); i.add_argument("--page", required=True)
    i.add_argument("--materials"); i.add_argument("--pipeline")
    s = sp.add_parser("say"); s.add_argument("ws"); s.add_argument("text", nargs="?", default="")
    s.add_argument("--files", nargs="*")
    t = sp.add_parser("status"); t.add_argument("ws")
    a = ap.parse_args()
    {"init": init, "say": say, "status": status}[a.cmd](a)
