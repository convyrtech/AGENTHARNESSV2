"""Дирижёр плейбука «страница сайта»: план в коде, свежая сессия Pi на каждый шаг, передача через файлы (research/16).

Зачем: в E8 одна длинная сессия вела весь пайплайн, контекст рос до сотен тысяч токенов, каждый вызов ждал 8–14 с до
первого токена, агент сам звал судью и сам решал, когда показывать владельцу. Здесь шаг выбирает flow.py, модель и
бюджет — stages.json, судью зовёт харнесс, второе мнение стоит перед каждым сообщением владельцу.

  run.py init <ws> --page <имя> [--materials <папка>]   завести рабочую папку
  run.py say  <ws> "<текст владельца>" [--files f ...] [--retry]   сообщение владельца → шаги до следующего вопроса
                                                         (--retry: после stuck начать лестницу моделей заново)
  run.py status <ws>                                     где мы, сколько потрачено

Вывод `say` — события JSONL в stdout (их читает вкладка «Дизайн» приложения):
  {"ev":"stage","gate":"2","title":…,"model":…,"attempt":1}   {"ev":"tool","name":…,"brief":…}
  {"ev":"note","text":…}   {"ev":"owner","text":…,"files":[…],"options":[…]}   {"ev":"done"}   {"ev":"stuck","text":…}
"""
import argparse, datetime as dt, hashlib, json, os, re, shutil, subprocess, sys, time, uuid
from pathlib import Path
for _s in (sys.stdout, sys.stderr):  # Windows: под -I PYTHONUTF8 не действует, а вывод в трубу идёт в cp1252
    _s.reconfigure(encoding="utf-8", errors="replace")

HERE = Path(__file__).resolve().parent
PLAYBOOK = HERE.parent                                  # playbooks/site
CFG = json.loads((HERE / "stages.json").read_text(encoding="utf-8"))
# HARNESS_MODELS: модели, которые реально есть на шлюзе (приложение берёт их из /v1/models). Лестница сужается до них,
# ступень без модели поднимается до ближайшей доступной (утром 2026-10-25 PRSLOY не отдавал deepseek и kimi, к ночи отдавал)
AVAILABLE = {m.strip() for m in os.environ.get("HARNESS_MODELS", "").split(",") if m.strip()}


def fit_ladder(cfg, available, gateway=""):
    # gateway_skip: модели, чей канал на этом шлюзе ломает шаг (PRSLOY 2026-10-25: qwen3.8-max выбрасывает system- и
    # developer-сообщения, а с ними задание шага, подмешивает ~2 тыс. скрытых токенов и теряет картинки)
    skip = [s.lower() for s in (cfg.get("gateway_skip") or {}).get(gateway, [])]

    def ok(m):
        return (not available or m.split("/", 1)[-1] in available) and not any(s in m.lower() for s in skip)
    if not available and not skip:
        return cfg
    orig = cfg["ladder"]
    keep = [m for m in orig if ok(m)]
    if not keep:
        return cfg                                   # ничего из лестницы нет: пусть шаг упадёт понятной ошибкой модели

    def remap(i):
        return next((keep.index(m) for m in orig[i:] if m in keep), len(keep) - 1)

    cfg["ladder"] = keep
    cfg["defaults"]["start"] = remap(cfg["defaults"].get("start", 0))
    for st in cfg["stages"].values():
        if "start" in st:
            st["start"] = remap(st["start"])
    judge = cfg.get("judge", {}).get("model")
    if (judge is not None and not ok(judge)) or (available and judge not in available):
        # зрительная роль — не ниже класса Opus (research/28 §4.4: Kimi K2.5 «видит» различие в 12,8 % одинаковых
        # пар, Opus — в 0,4 %): самая сильная ступень этого класса, иначе любая модель класса из шлюза, иначе никто
        strong = [m.split("/", 1)[-1] for m in reversed(keep) if VISUAL_CLASS.search(m)]
        strong += sorted(m for m in available if VISUAL_CLASS.search(m) and ok(m))
        cfg.setdefault("judge", {})["model"] = strong[0] if strong else None
    return cfg


# Модели для зрительных ролей (судья, пометки владельца на картинке): класс Opus и сопоставимые по замерам DiffSpot /
# PerceptUI (research/28 §2.2, §4.4). Kimi и qwen сюда не входят, пока калибровка (§4.2) не покажет обратное.
VISUAL_CLASS = re.compile(r"opus|gpt-6|gpt-5\.[4-9]|gemini-[3-9][\w.-]*-pro", re.I)
CFG = fit_ladder(CFG, AVAILABLE, os.environ.get("HARNESS_GATEWAY", ""))
# A/B шага 5 без правки stages.json: HARNESS_PARALLEL5=1 включает параллельные прототипы, 0 — выключает
if os.environ.get("HARNESS_PARALLEL5") in ("0", "1"):
    CFG["stages"].setdefault("5", {})["parallel"] = os.environ["HARNESS_PARALLEL5"] == "1"
# пометки владельца кистью на картинке («Дизайн», research/20 §10): файл marks-*.png; такой ход — модели со зрением
MARKS = re.compile(r"^marks-.+\.png$", re.I)
# ход с пометками — зрительная роль: та же планка, что у судьи
VISION = VISUAL_CLASS


def marks_note(files):
    """Строка в задание, когда владелец приложил пометки поверх картинки."""
    marked = [f for f in files if MARKS.match(Path(f).name)]
    if not marked:
        return ""
    return ("Владелец обвёл места на картинке: " + ", ".join(marked) + ". Открой файл и посмотри. Красное на "
            "картинке — пометки владельца, не дизайн: исправь то, что он обвёл, красное в работу не переносить.")


def vision_model(ladder, rung):
    """Ступень лестницы со зрением: с текущей вверх, иначе любая со зрением, иначе текущая."""
    return next((m for m in ladder[rung:] + ladder if VISION.search(m)), ladder[min(rung, len(ladder) - 1)])
# уроки шагов по моделям (research/18 §8): в задание идут только active/trial; HARNESS_LESSONS=0 выключает
LESSONS = (json.loads((HERE / "lessons.json").read_text(encoding="utf-8"))["lessons"]
           if (HERE / "lessons.json").exists() else [])
PY = sys.executable
# PI_BIN: "pi" или JSON-список, например ["C:\\PRSLOY\\node.exe", "C:\\PRSLOY\\pi\\cli.js"] в приложении
PI = json.loads(os.environ["PI_BIN"]) if os.environ.get("PI_BIN", "").startswith("[") else [os.environ.get("PI_BIN", "pi")]
PI[0] = shutil.which(PI[0]) or PI[0]
WIN = os.name == "nt"
# PROGRAMFILES*: Playwright finds Edge (channel msedge) through them; without them every browser tool of the agent
# failed on Windows (Edge lives in Program Files (x86)). Python upper-cases Windows env names.
SAFE = ("PATH", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SYSTEMROOT", "COMSPEC", "PATHEXT", "TEMP", "TMP",
        "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432",
        # системные переменные Windows без секретов: без WINDIR/SYSTEMDRIVE часть программ (cmd, Edge) ведёт себя странно
        "WINDIR", "SYSTEMDRIVE", "PROGRAMDATA", "ALLUSERSPROFILE", "PUBLIC", "HOMEDRIVE", "HOMEPATH", "USERNAME",
        "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS",
        "LANG", "LC_ALL", "TERM", "TMPDIR", "PLAYWRIGHT_BROWSERS_PATH", "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD",
        "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy", "SSL_CERT_FILE",
        "REQUESTS_CA_BUNDLE", "NODE_EXTRA_CA_CERTS", "CURL_CA_BUNDLE", "PI_CODING_AGENT_DIR",
        "PI_OFFLINE", "PI_SKIP_VERSION_CHECK", "PI_TELEMETRY", "DP_BROWSER_CHANNEL", "DP_CHROMIUM_ONLY")
# адрес прокси надёжности для judge.py и second_opinion.py; приложение поднимает его на свободном порту
PROXY = ["--proxy", os.environ["HARNESS_PROXY"]] if os.environ.get("HARNESS_PROXY") else []
SHIMS = ("claude", "codex", "gemini", "aider", "cursor-agent", "opencode", "qwen", "kimi")
ENDS_OK = "ЭТАП ГОТОВ"
TO_OWNER = "ВЛАДЕЛЬЦУ:"
# вопрос владельцу инструментом (research/20 §8): расширение Pi рядом с харнессом; без него — старый путь TO_OWNER
ASK_EXT = Path(__file__).resolve().with_name("ask_owner.ts")
# разметка вызова инструментов, утёкшая в текст: DeepSeek V4 (DSML), DeepSeek V3, Qwen/Hermes, Kimi
TOOL_LEAK = re.compile(r"｜\s*DSML\s*｜|<｜tool▁calls?▁(?:begin|end)｜>|<｜tool▁sep｜>|</?tool_call>"
                       r"|<\|tool_calls?_(?:section_)?(?:begin|end)\|>")
LEAK_NUDGE = ("Твой последний вызов инструмента не дошёл: он пришёл текстом. Повтори его обычным вызовом "
              "инструмента, без рассуждений в ответе.")
LEAK_RETRIES = 2


def emit(**ev):
    ev["t"] = round(time.time(), 1)
    print(json.dumps(ev, ensure_ascii=False), flush=True)


class WS:
    def __init__(self, root):
        self.root = Path(root).resolve()
        # состояние харнесса (журнал, сессии, переписка судьи, шимы) — вне папки агента: в E9 DeepSeek потратил
        # шаг на чтение ledger.jsonl и чужих сессий. Агенту в <ws>/harness остаются только его инструменты.
        legacy = self.root / "harness" / "state.json"
        env_dir = os.environ.get("HARNESS_STATE_DIR")
        if env_dir:
            self.h = Path(env_dir).resolve()
        elif legacy.exists():
            self.h = legacy.parent
        else:
            self.h = self.root.parent / f".{self.root.name}.harness"
        self.tools = self.root / "harness"
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
        # сессия журнала обучения — проект, а не процесс: run.py запускается на каждое сообщение владельца
        if "learn_session" not in self.state:
            self.state["learn_session"] = uuid.uuid4().hex[:12]
            self.save()
        learn_event(rec, self.state["learn_session"])

    def env(self):
        env = {k: v for k, v in os.environ.items() if k in SAFE}
        env["PATH"] = str(self.h / "bin") + os.pathsep + env.get("PATH", "")
        env["FLOW_TRANSCRIPTS"] = str(self.h / "tx")
        # Python агента (не под -I) печатает в трубу UTF-8: иначе на Windows cp1252 и падение на «Иван Петров»
        env["PYTHONUTF8"] = "1"
        env["PYTHONIOENCODING"] = "utf-8"
        return env


# ---------- init ----------
def init(a):
    ws = WS(a.ws)
    src = Path(a.pipeline or os.environ.get("DESIGN_PIPELINE", "")).resolve()
    if not (src / "tools" / "flow.py").exists():
        sys.exit("run.py init: нужна копия design-pipeline (--pipeline или DESIGN_PIPELINE)")
    ws.root.mkdir(parents=True, exist_ok=True)
    for d in ("owner", "materials", "design", "site", "harness"):
        (ws.root / d).mkdir(parents=True, exist_ok=True)
    for d in ("tx", "sessions", "bin"):
        (ws.h / d).mkdir(parents=True, exist_ok=True)
    if not ws.pipe.exists():
        shutil.copytree(src, ws.pipe, ignore=shutil.ignore_patterns(".git", "__pycache__", "examples"))
        patch = HERE / "pipeline-fixes.patch"
        # копия из приложения приходит с уже наложенным патчем (git на Windows может не быть): метка — его sha256
        mark = ws.pipe / ".pipeline-fixes.sha256"
        applied = patch.exists() and mark.exists() and mark.read_text().strip() == hashlib.sha256(patch.read_bytes()).hexdigest()
        if patch.exists() and not applied:
            # git apply внутри чужого репозитория молча пропускает файлы вне его индекса: потолок поиска репозитория
            # на папке проекта, патч ложится на файлы копии как обычный diff
            env = {**os.environ, "GIT_CEILING_DIRECTORIES": str(ws.root)}
            r = subprocess.run(["git", "apply", "-p1", str(patch)], cwd=ws.pipe, env=env, capture_output=True, text=True)
            if r.returncode:
                emit(ev="note", text="патч пайплайна не лёг: " + r.stderr[:200])
            else:
                mark.write_text(hashlib.sha256(patch.read_bytes()).hexdigest())
        shutil.copytree(PLAYBOOK / "motion", ws.pipe / "motion", ignore=shutil.ignore_patterns("sheets", "__pycache__"))
    cat = PLAYBOOK.parents[1] / "experiments" / "e8b" / "etalons"
    if cat.exists() and not (ws.root / "etalons").exists():
        shutil.copytree(cat, ws.root / "etalons", ignore=shutil.ignore_patterns("*.mp4", "frames*", "__pycache__"))
    shutil.copyfile(HERE / "AGENTS.md", ws.root / "AGENTS.md")
    for f in ("check.py", "brand_check.py", "second_opinion.py"):  # служебные: в состоянии харнесса
        shutil.copyfile(HERE / f, ws.h / f)
    for f in ("moves.py", "check.py", "brand_check.py"):        # инструменты агента: в его папке
        shutil.copyfile(HERE / f, ws.tools / f)
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
    # «Текст владельца» — его готовый текст для страницы, не переписка: канал там давал вечный FAIL text_diff (E9)
    known = {"Канал владельца": "owner/messages.jsonl", "Решения": "нет", "Расшифровки голоса": "нет",
             "Текст владельца": "нет",
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


def tree_fp(*dirs):
    """Отпечаток файлов (имя, размер, mtime) — признак, что шаг что-то сделал."""
    h = hashlib.sha1()
    for d in dirs:
        if not d.exists():
            continue
        for f in sorted(x for x in d.rglob("*") if x.is_file() and "outbox" not in x.parts):
            st = f.stat()
            h.update(f"{f.relative_to(d)}:{st.st_size}:{int(st.st_mtime)}".encode())
    return h.hexdigest()


def judge_cap_message(ws):
    """Сообщение владельцу после лимита раундов судьи: снимок страницы, главное из находок, два варианта."""
    jt = (ws.page / "artifacts" / "judge" / "JUDGE.md").read_text(encoding="utf-8")
    rows = [[c.strip() for c in ln.strip().strip("|").split("|")] for ln in jt.splitlines()
            if ln.strip().startswith("|") and not re.match(r"^\|\s*-", ln.strip()) and "Серьёзн" not in ln]
    bad = [r for r in rows if r and re.match(r"(blocker|critical)", r[0], re.I)]
    other = [r for r in rows if r and not re.match(r"(blocker|critical)", r[0], re.I)]
    shot = next((s for s in ("contact-chromium-390.png", "contact-chromium-1440.png")
                 if (ws.page / "artifacts" / "visual-gate" / s).exists()), None)
    rel = f"design/{ws.state['page']}/artifacts/visual-gate/{shot}" if shot else ""
    # подробности находок техничны для казуала: только счёт; список лежит в JUDGE.md для агента
    lines = ([rel] if rel else []) + [
        f"Страница собрана. Строгий проверяющий нашёл важных замечаний: {len(bad)}, мелких: {len(other)}.",
        "А. Выложить как есть",
        "Б. Исправить важные и показать снова (рекомендую)" if bad else "Б. Исправить и показать снова"]
    files = [str((ws.root / rel).resolve())] if rel else []
    return "\n".join(lines), files


def snapshots_fp(ws):
    """Отпечаток контакт-листов гейта: судья смотрит их, новый раунд имеет смысл только по новым."""
    h = hashlib.sha1()
    for f in sorted((ws.page / "artifacts" / "visual-gate").glob("contact-*.png")):
        st = f.stat()
        h.update(f"{f.name}:{st.st_size}:{int(st.st_mtime)}".encode())
    return h.hexdigest()


def run_judge(ws):
    if not CFG["judge"].get("model"):
        ws.ledger(kind="judge", exit=5, out="no visual-class model")
        return 5, "нет модели уровня Opus для проверки картинки"
    r = subprocess.run([PY, "-I", str(HERE / "judge.py"), "--page", str(ws.page), "--transcripts", str(ws.h / "tx"),
                        "--pipeline", str(ws.pipe), "--model", CFG["judge"]["model"],
                        "--max-images", str(CFG["judge"].get("max_images", 3)),
                        "--max-rounds", str(CFG["judge"]["max_rounds"] + ws.state.get("judge_bonus", 0)), *PROXY],
                       cwd=ws.root, capture_output=True, text=True, encoding="utf-8")
    # вердикт полями, а не только хвостом вывода: хвост в 400 знаков режет JSON со списком снимков, а A/B (#21)
    # считает по ним качество — вердикт первого раунда, раунды до PASS, находки по серьёзности
    try:
        j = json.loads(r.stdout.strip().splitlines()[-1]) if r.returncode == 0 else {}
    except (ValueError, IndexError):
        j = {}
    ws.ledger(kind="judge", exit=r.returncode, out=r.stdout[-400:],
              **{k: j[k] for k in ("round", "verdict", "findings", "yes", "no", "cost") if k in j})
    return r.returncode, r.stdout.strip()


def second_opinion(ws, text, model, gate=""):
    fam = family(model)
    checker = next((m for m in CFG["ladder"] if family(m) != fam), CFG["ladder"][0]).split("/", 1)[1]
    mf = ws.h / f"msg-{ws.state['outbox'] + 1:02d}.txt"
    mf.write_text(text, encoding="utf-8")
    sent = [o for o in owner_messages(ws, limit=50)]
    known = "\n".join(f"- «{o.get('text')}»" + (f" + файлы: {', '.join(o['files'])}" if o.get("files") else "") for o in sent)
    r = subprocess.run([PY, "-I", str(ws.h / "second_opinion.py"), str(ws.root), str(mf), "--model", checker,
                        "--gate", gate, "--known", known[-3000:], *PROXY],
                       capture_output=True, text=True, encoding="utf-8")
    try:
        op = json.loads(r.stdout)
    except ValueError:
        return None
    ws.ledger(kind="second_opinion", model=checker, verdict=op.get("verdict"))
    return op


def lessons_for(gate, model):
    """До 5 уроков шага для модели, не больше 900 символов (research/18 §6.1)."""
    if os.environ.get("HARNESS_LESSONS") == "0" or not model:
        return []
    m, out, size = model.lower(), [], 0
    for ls in LESSONS:
        if ls.get("status") not in ("active", "trial") or ls.get("gate") not in (gate, "*"):
            continue
        if not any(x == "*" or x in m for x in ls.get("models", [])):
            continue
        if len(out) >= 5 or size + len(ls["text"]) > 900:
            break
        out.append(ls)
        size += len(ls["text"])
    return out


def learn_event(rec, session=None):
    """Событие для самообучения без текстов (research/18 §7.2): только виды, числа, модель, шаг. Пишет, только если
    приложение задало HARNESS_LEARN_DIR; A/B и разработка ничего не копят."""
    d = os.environ.get("HARNESS_LEARN_DIR")
    if not d:
        return
    keep = ("kind", "gate", "model", "attempt", "calls", "seconds", "end", "leaks", "verdict", "to", "exit", "ts",
            "lessons")
    ev = {k: rec[k] for k in keep if k in rec}
    if session:
        ev["session"] = session                         # проект для рефлектора (S7): «≥3 сессии» без текстов
    if rec.get("killed"):
        k = rec["killed"]
        ev["killed"] = "loop" if k.startswith("петля") else "calls" if "вызовов" in k else "time" if "время" in k else "other"
    if rec.get("error"):
        ev["error"] = True
    try:
        Path(d).mkdir(parents=True, exist_ok=True)
        f = Path(d) / "design-events.jsonl"
        if f.exists() and f.stat().st_size > 5 * 1024 * 1024:
            f.replace(f.with_suffix(".jsonl.1"))
        with open(f, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(ev, ensure_ascii=False) + "\n")
    except OSError:
        pass                                            # журнал обучения не должен ронять шаг


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


def brief(ws, gate, fl, cfg, notes, model=None):
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
    les = lessons_for(gate, model)
    if les:
        lines += ["", "## Уроки прошлых прогонов (для этой модели)", *[f"- {x['text']}" for x in les]]
    if notes:
        lines += ["", "## Проверки харнесса (не владелец): исправь до показа владельцу", *notes]
    said = [f"- {o.get('date')}: «{o.get('text')}»" + (f" [файлы: {', '.join(o['files'])}]" if o.get("files") else "")
            for o in msgs] or ["- (пока нет)"]
    ob = sorted((ws.h / "sent").glob("*.md")) if (ws.h / "sent").exists() else []
    if ob:
        # свежая сессия не помнит, о чём спрашивали: без этого ответ «а а а» непонятен и вопрос задаётся заново (E9)
        lines += ["", f"## Последнее сообщение владельцу (отправлено харнессом, {ob[-1].name})",
                  ob[-1].read_text(encoding="utf-8").strip(),
                  "Ответ владельца на него — самое новое сообщение ниже. Буквы в ответе идут по порядку вопросов."]
    lines += ["", "## Последние сообщения владельца (дословно)", *said,
              "", "## STATUS.md сейчас", st[:4000], "", "## Файлы страницы", ", ".join(files)[:1500],
              "", "## Как закончить",
              f"- Шаг сделан и `python3 -I design-pipeline/tools/flow.py --page design/{ws.state['page']}` его пропускает: "
              f"последней строкой напиши «{ENDS_OK}».",
              *([("- Для шага нужен ответ владельца (выбор по листу, «да», материалы, название): вызови инструмент "
                  "ask_owner. message — текст по design-pipeline/templates/OWNER-MESSAGE.md (до 5 строк, путь к картинке "
                  "или видео отдельной строкой); questions — до трёх вопросов, у каждого 2–4 варианта и recommended, или "
                  "один вопрос freeform, когда нужны его слова. Вызов заканчивает сессию. Вопрос владельцу — только "
                  "инструментом ask_owner.")] if ASK_EXT.exists() else [
                f"- Для шага нужен ответ владельца (выбор по листу, «да», материалы): закончи сообщением ему. Первая "
                f"строка «{TO_OWNER}», дальше текст по design-pipeline/templates/OWNER-MESSAGE.md (до 5 строк, один "
                "вопрос, своя рекомендация, путь к картинке или видео). Больше ничего после него не пиши."]),
              "- Владельцу пишешь только так. Строки ВЫБОР — только его слова из сообщений выше."]
    return "\n".join(lines)


DOING = [  # первое совпадение по команде или аргументам; нет совпадения — None, приложение берёт строку по шагу
    (r"gate\.py|visual_gate", "Проверяю страницу на телефоне и компьютере"),
    (r"motion_probe|check_motion", "Проверяю плавность движения"),
    (r"moves\.py candidates", "Снимаю варианты движения"),
    (r"moves\.py pick", "Разбираю выбранный вариант"),
    (r"etalon_video|skillry-index", "Смотрю референсы"),
    (r"compare_sheet|contact_sheet|storyboard", "Собираю лист для выбора"),
    (r"check\.py", "Проверяю страницу"),
    (r"slop|text_diff|lint-message", "Сверяю тексты"),
    (r"flow\.py", "Сверяюсь с планом шага"),
]


def doing_of(name, arg):
    a = str(arg)
    for pat, say_ in DOING:
        if re.search(pat, a):
            return say_
    if name == "read" and re.search(r"\.(png|jpe?g|webp)", a, re.I):
        return "Смотрю снимки"
    if name in ("edit", "write") and re.search(r"\.(html|css|js)\b", a):
        return "Пишу страницу"
    if name in ("edit", "write") and re.search(r"\.md\b", a):
        return "Записываю решения"
    return None


def leaked(final, thinking):
    """Вызов инструмента пришёл текстом (E9 A/B: DeepSeek, 3 сессии из 22 на шаге 7): stop без toolCall, в тексте
    закрывающие теги своей разметки инструментов, текст дословно повторяет рассуждение. Pi считает ход законченным."""
    return bool(TOOL_LEAK.search(final)) or (len(final) > 1000 and final.strip() == (thinking or "").strip())


def run_stage(ws, gate, prompt, model, cfg, session):
    """Одна сессия Pi с бюджетом и детекторами петель. Возвращает (final_text, stats)."""
    t0 = time.time()
    st = {"calls": 0, "in": 0, "out": 0, "cached": 0, "cost": 0.0, "edits_since_check": 0, "killed": None,
          "leaks": 0, "ask": None, "ask_errors": 0}
    seen = {}
    deadline = t0 + cfg["max_minutes"] * 60
    while True:
        final, thinking = _pi_once(ws, prompt, model, cfg, session, st, seen, deadline)
        if st["killed"] or st.get("error") or not leaked(final, thinking) or st["leaks"] >= LEAK_RETRIES:
            break
        # та же сессия: контекст в кэше, повтор дешевле свежей сессии шага
        st["leaks"] += 1
        emit(ev="note", text="модель отдала вызов инструмента текстом, прошу повторить")
        prompt = LEAK_NUDGE
    if st["leaks"] and leaked(final, thinking):
        final = ""                                  # мусор разметки не идёт ни владельцу, ни в «ЭТАП ГОТОВ»
    st["seconds"] = round(time.time() - t0)
    return final.strip(), st


def _pi_once(ws, prompt, model, cfg, session, st, seen, deadline):
    # задание идёт файлом (@file): длинный многострочный текст в командной строке ломается на Windows
    session.parent.mkdir(parents=True, exist_ok=True)
    bf = session.with_name(session.stem + f"-{time.time_ns()}.brief.md")
    bf.write_text(prompt, encoding="utf-8")
    args = [*PI, "--mode", "json", "--model", model, "--session", str(session),
            *(["-e", str(ASK_EXT)] if ASK_EXT.exists() else []), "@" + str(bf),
            "Выполни задание харнесса из файла выше."]
    final, thinking = "", ""
    p = subprocess.Popen(args, cwd=ws.root, env=ws.env(), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                         stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace")
    log = open(session.with_suffix(".events.jsonl"), "a", encoding="utf-8")
    for ln in p.stdout:
        log.write(ln)
        if time.time() > deadline:
            st["killed"] = f"время шага вышло ({cfg['max_minutes']} мин)"
            break
        try:
            e = json.loads(ln)
        except ValueError:
            continue
        if e.get("type") == "tool_execution_end" and e.get("toolName") == "ask_owner":
            # вопрос владельцу принят инструментом (он и проверил форму); кривой вызов — ошибка модели, она повторит
            if e.get("isError"):
                st["ask_errors"] += 1
            elif isinstance((e.get("result") or {}).get("details"), dict):
                st["ask"] = e["result"]["details"]
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
        final = thinking = ""                       # итог хода — только последнее сообщение ассистента
        for b in m.get("content") or []:
            if b.get("type") == "text" and b.get("text"):
                final = b["text"]
            if b.get("type") == "thinking":
                thinking = b.get("thinking") or ""
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
            emit(ev="tool", name=b.get("name"), brief=(cmd or argj)[:120], doing=doing_of(b.get("name"), cmd or argj))
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
    return final, thinking


# ---------- say: owner message → stages until the next question ----------
LETTER = r"[A-DА-Г]"
# вариант, который требует слов владельца: кнопкой его не ответить, для него есть поле ввода
FREEFORM = re.compile(r"(?i)назов|напиш|друг(ой|ие|ую)|сво[йиюе]|иначе|поправ")
PRONOUN = re.compile(r"(?i)\b(его|её|ее|это|эту|этот|эти|их|так)\b")


def inline_options(text):
    """Кнопки для показа листа без строк «А. …» (шаблон OWNER-MESSAGE: «Берём A, B или смешать?», «Выкладываем?»).
    Разбирает только вопрос в последней строке с «?»; не уверен — пусто, у владельца остаётся поле ввода."""
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    qs = [ln for ln in lines if ln.endswith("?")]
    if not qs:
        return []
    q = qs[-1]
    rec = " ".join(ln for ln in lines if re.search(r"(?i)рекоменду", ln) and not re.search(r"(?i)не рекоменду", ln))
    body = re.split(r"[:.!]\s+", q.rstrip("?").strip())[-1].strip()
    rec_letter = re.search(rf"(?i)рекомендую\s+(?:вариант\s+)?({LETTER})(?![\w+])", rec)
    about = {}                                     # «A: прибор и три шага.» — подпись кнопки; строку рекомендации не берём
    for ln in lines:
        if not re.search(r"(?i)рекоменду", ln):
            for m in re.finditer(rf"(?:^|[\s.])({LETTER}):\s*([^.?\n]+)", ln):
                about.setdefault(m.group(1), m.group(2).strip())

    def letter(x):
        return {"key": x, "label": f"{x} — {about[x]}" if x in about else x,
                "recommended": bool(rec_letter and rec_letter.group(1) == x)}

    m = re.search(rf"((?:{LETTER}\s*,\s*)*{LETTER})\s+или\s+(.+)$", body)
    if m:
        opts = [letter(x) for x in re.findall(LETTER, m.group(1))]
        last = m.group(2).strip()
        if re.fullmatch(LETTER, last):
            opts.append(letter(last))
        elif not FREEFORM.search(last):
            opts.append({"key": last, "label": last[:1].upper() + last[1:], "recommended": False})
    elif " или " in body:
        alts = [a.strip() for a in body.split(" или ") if a.strip()]
        opts = [{"key": a, "label": a[:1].upper() + a[1:],
                 "recommended": bool(rec and (PRONOUN.search(a) or a.lower() in rec.lower()))}
                for a in alts if not FREEFORM.search(a)]
    elif len(body) <= 60:
        opts = [{"key": "да", "label": "Да", "recommended": bool(rec)},
                {"key": "нет", "label": "Нет, поправить", "recommended": False}]
    else:
        opts = []
    if len(opts) < 2 and not (opts and len(opts) == 1 and opts[0]["recommended"]):
        return []
    return [{"q": "", "options": opts}]


def ask_card(ask):
    """Текст и кнопки карточки из вызова ask_owner — в том же виде, что сообщение по шаблону: строки «A. …»
    и «(рекомендую)», вопросы нумеруются, когда их несколько (flow.py и ответ «1А 2Б» читают так же)."""
    qs = [q for q in (ask or {}).get("questions") or [] if isinstance(q, dict) and q.get("prompt")]
    if not qs:
        return None
    lines = [ask["message"].strip()] if str(ask.get("message") or "").strip() else []
    groups = []
    for i, q in enumerate(qs, 1):
        lines.append(f"{i}. {q['prompt']}" if len(qs) > 1 else q["prompt"])
        opts = [{"key": o["key"], "label": o["label"], "recommended": bool(o.get("recommended"))}
                for o in q.get("options") or [] if isinstance(o, dict) and o.get("key") and o.get("label")]
        lines += [f"{o['key']}. {o['label']}" + (" (рекомендую)" if o["recommended"] else "") for o in opts]
        if opts:
            groups.append({"q": q["prompt"], "options": opts})
    return "\n".join(lines), groups


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
    return [g for g in groups if g["options"]][:3] or inline_options(text)


# ---------- шаг 5: «рекомендую» между A и B — моделью в обеих перестановках (research/28 §4.4) ----------
PAIR_LETTER = {"a": "a", "а": "a", "b": "b", "б": "b"}


def pair_pick(ws):
    """Какой прототип лучше: pair_pick.py в двух порядках, ответ засчитывается при совпадении. Кэш — по файлам
    прототипов. {"winner": "a"|"b"|None, ...} или None, когда сравнивать нечего (нет двух прототипов)."""
    pa, pb = (ws.page / "05-proto" / x / "index.html" for x in "ab")
    if not (pa.exists() and pb.exists()):
        return None
    fp = ":".join(f"{p.stat().st_size}:{int(p.stat().st_mtime)}" for p in (pa, pb))
    cached = ws.state.get("pair5") or {}
    if cached.get("fp") == fp:
        return cached
    if not CFG["judge"].get("model"):
        res = {"winner": None, "why": "нет модели уровня Opus"}
    else:
        r = subprocess.run([PY, "-I", str(HERE / "pair_pick.py"), "--a", str(pa), "--b", str(pb),
                            "--brief", str(ws.page / "MESSAGE.md"), "--pipeline", str(ws.pipe),
                            "--out", str(ws.page / "artifacts" / "pair5"), "--model", CFG["judge"]["model"], *PROXY],
                           cwd=ws.root, env={**os.environ, **ws.env()}, capture_output=True, text=True,
                           encoding="utf-8")
        try:
            res = json.loads(r.stdout.strip().splitlines()[-1])
        except (ValueError, IndexError):
            ws.ledger(kind="pair5", ok=False, out=(r.stdout + r.stderr)[-300:])
            return None                                   # сбой сравнения: карточку не трогаем
    res["fp"] = fp
    ws.state["pair5"] = res
    ws.save()
    ws.ledger(kind="pair5", ok=True, winner=res.get("winner"), answers=res.get("answers"))
    return res


def apply_pair_pick(text, options, res):
    """«(рекомендую)» у A или B — только по выбору, совпавшему в обоих порядках; разошлись — ни у одного, и строка
    владельцу. Остальные варианты (гибрид и т. п.) не трогаются."""
    if not res:
        return text, options
    win = res.get("winner")
    lines = []
    for ln in text.splitlines():
        m = re.match(r"^(\s*)([A-BА-Б])([.)]\s+)(.*?)(\s*\(рекомендую\))?\s*$", ln)
        if m:
            mark = " (рекомендую)" if PAIR_LETTER.get(m.group(2).lower()) == win else ""
            ln = f"{m.group(1)}{m.group(2)}{m.group(3)}{m.group(4)}{mark}"
        lines.append(ln)
    if not win:
        lines.append("Какой из двух лучше, проверка не решила: выберите сами.")
    for g in options or []:
        for o in g.get("options", []):
            k = PAIR_LETTER.get(str(o.get("key", "")).strip().lower())
            if k:
                o["recommended"] = k == win
    return "\n".join(lines), options


# ---------- шаг 5: прототипы параллельно одним вызовом (research/20, вопрос 3; stages.json → 5.parallel) ----------
# Вместо одной сессии до 40 минут: 2–3 одноразовых вызова «создай index.html целиком» на разных ступенях лестницы,
# у каждого блок дизайн-системы (идея screenshot-to-code prompts/design_system.py, MIT: «при конфликте побеждает
# дизайн-система»). В работу идут первые два удачных; лист — compare_sheet.py; спрашивает владельца обычная
# сессия шага через ask_owner. Меньше двух удачных — шаг идёт старым путём.
PROTO_ENERGY = [("A", "спокойный и собранный: ровный ритм, много воздуха, движение мягкое и редкое"),
                ("B", "смелый и энергичный: крупная типографика, контраст, движение заметное, с характером"),
                ("C", "с необычной механикой: страница ведёт по шагам или раскрывается по ходу, движение — часть смысла")]
HTML_BLOCK = re.compile(r"```(?:html)?\s*\n(.*?)```", re.S | re.I)


def design_system(ws):
    """Блок дизайн-системы для одноразового вызова: 02-brand.md и замер сайта владельца (brand.json)."""
    parts = []
    md = ws.page / "02-brand.md"
    if md.exists():
        parts.append(md.read_text(encoding="utf-8")[:6000])
    bj = ws.root / "materials" / "brand.json"
    if bj.exists():
        try:
            b = json.loads(bj.read_text(encoding="utf-8"))
            keep = {k: b.get(k) for k in ("colors", "palette", "fonts", "radius") if b.get(k)}
            parts.append("Замер сайта владельца (materials/brand.json):\n" + json.dumps(keep, ensure_ascii=False)[:3000])
        except ValueError:
            pass
    return "\n\n".join(parts) or "Дизайн-системы ещё нет: бери цвета и шрифты из материалов владельца, без новых."


def proto_brief(ws, energy):
    """Задание одноразового вызова: всё нужное в одном тексте, файлы читать нельзя (инструментов нет)."""
    def doc(name, limit):
        f = ws.page / name
        return f.read_text(encoding="utf-8")[:limit] if f.exists() else "(нет)"
    return "\n".join([
        "Сделай прототип одностраничного сайта: один файл index.html целиком (HTML, CSS и JS внутри файла).",
        f"Характер этого варианта: {energy}.",
        "Верни только код в одном блоке ```html … ```, без пояснений.",
        "", "## Дизайн-система (при любом конфликте с этим заданием побеждает дизайн-система)",
        design_system(ws),
        "", "## Текст — только отсюда, слово в слово; чисел и обещаний сверх этого не придумывать",
        "### FACTS.md", doc("FACTS.md", 6000), "### MESSAGE.md", doc("MESSAGE.md", 6000),
        "", "## Выбранное движение (04-motion.md)", doc("04-motion.md", 3000),
        "", "## Решения владельца (STATUS.md)", doc("STATUS.md", 3000),
        "", "## Правила",
        "- Растровых картинок интерфейса нет: всё живым кодом (HTML, CSS, SVG). Внешних ссылок на картинки нет.",
        "- Сайт работает на телефоне 390 px и на компьютере 1440 px; ничего не вылезает за край.",
        "- Шрифты — из дизайн-системы (системные запасные в font-family). Цвета — только из дизайн-системы.",
        "- Фирменный приём из 04-motion.md — живым элементом с атрибутом data-signature.",
        "- Уважай prefers-reduced-motion.",
    ])


def extract_html(text):
    m = HTML_BLOCK.search(text or "")
    html = m.group(1) if m else text or ""
    start = re.search(r"<!doctype html|<html", html, re.I)
    end = html.lower().rfind("</html>")
    if not start or end < 0:
        return None
    html = html[start.start():end + len("</html>")]
    return html if len(html) >= 1500 and re.search(r"<body", html, re.I) else None


def one_shot(ws, model, prompt, out_dir, timeout):
    """Один вызов модели без инструментов: (html или None, статистика)."""
    out_dir.mkdir(parents=True, exist_ok=True)
    bf = out_dir / f"brief-{time.time_ns()}.md"
    bf.write_text(prompt, encoding="utf-8")
    args = [*PI, "--mode", "json", "--model", model, "--no-tools", "--no-context-files", "--no-skills",
            "--session", str(out_dir / "session.jsonl"), "@" + str(bf), "Выполни задание из файла выше."]
    st = {"model": model, "in": 0, "out": 0, "cost": 0.0, "error": None}
    t0 = time.time()
    final = ""
    try:
        r = subprocess.run(args, cwd=ws.root, env=ws.env(), stdin=subprocess.DEVNULL, capture_output=True,
                           text=True, encoding="utf-8", errors="replace", timeout=timeout)
        out = r.stdout
    except subprocess.TimeoutExpired as e:
        out = e.stdout.decode("utf-8", "replace") if isinstance(e.stdout, bytes) else (e.stdout or "")
        st["error"] = f"время вышло ({round(timeout)} с)"
    for ln in out.splitlines():
        try:
            e = json.loads(ln)
        except ValueError:
            continue
        m = e.get("message") or {}
        if e.get("type") != "message_end" or m.get("role") != "assistant":
            continue
        if m.get("stopReason") == "error":
            st["error"] = (m.get("errorMessage") or "ошибка модели")[:200]
        u = m.get("usage") or {}
        st["in"] += u.get("input", 0) or 0
        st["out"] += u.get("output", 0) or 0
        st["cost"] += (u.get("cost") or {}).get("total", 0) or 0
        final = next((b.get("text") for b in m.get("content") or [] if b.get("type") == "text" and b.get("text")),
                     final)
    st["seconds"] = round(time.time() - t0)
    html = extract_html(final)
    if html is None and not st["error"]:
        st["error"] = "в ответе нет целого index.html"
    return html, st


def parallel_protos(ws, cfg):
    """2–3 прототипа параллельно → 05-proto/a, b и лист 05-compare.png. Число вызовов модели или 0 (старый путь)."""
    from concurrent.futures import ThreadPoolExecutor
    ladder = CFG["ladder"]
    start = min(cfg.get("start", 0), len(ladder) - 1)
    order = ladder[start:] + ladder[:start]
    n = max(2, min(int(cfg.get("parallel_variants", 3)), 3, len(PROTO_ENERGY)))
    jobs = [(PROTO_ENERGY[i], order[i % len(order)]) for i in range(n)]
    timeout = float(cfg.get("parallel_minutes", 8)) * 60
    work = ws.h / "protos" / time.strftime("%Y%m%d-%H%M%S")
    emit(ev="note", text=f"Собираю {n} прототипа сразу: " + ", ".join(m.split("/", 1)[-1] for _, m in jobs))
    with ThreadPoolExecutor(max_workers=n) as pool:
        futs = [pool.submit(one_shot, ws, model, proto_brief(ws, energy), work / letter, timeout)
                for (letter, energy), model in jobs]
        results = [f.result() for f in futs]
    good = []
    for ((letter, _), model), (html, st) in zip(jobs, results):
        ws.ledger(kind="proto", gate="5", batch=work.name, variant=letter, ok=html is not None, **st)
        emit(ev="note", text=f"прототип {letter} ({model.split('/', 1)[-1]}): "
                             + (f"готов за {st['seconds']} с" if html else f"не получился — {st['error']}"))
        if html:
            good.append(html)
    if len(good) < 2:
        ws.ledger(kind="proto_fallback", gate="5", ok=len(good))
        return 0
    for letter, html in zip("ab", good[:2]):           # выбор шага 5 — A, B или гибрид: в работу два варианта
        d = ws.page / "05-proto" / letter
        d.mkdir(parents=True, exist_ok=True)
        (d / "index.html").write_text(html, encoding="utf-8")
    r = subprocess.run([PY, "-I", str(ws.pipe / "tools" / "compare_sheet.py"),
                        "--variant", str(ws.page / "05-proto" / "a" / "index.html"),
                        "--variant", str(ws.page / "05-proto" / "b" / "index.html"),
                        "--out", str(ws.page / "05-compare.png")],
                       cwd=ws.root, env=ws.env(), capture_output=True, text=True, encoding="utf-8")
    if r.returncode:
        emit(ev="note", text="лист сравнения не снялся: " + (r.stderr or r.stdout)[-200:])
    return n


# ---------- правка владельца на готовой странице (research/20 §1–2) ----------
EDIT_CFG = {"max_calls": 30, "max_minutes": 10, "same_call_limit": 3, "edits_without_check": 15}


def shoot(ws, html, out, width, targets_file, boxes_out):
    r = subprocess.run([PY, "-I", str(HERE / "edit_check.py"), "shoot", "--html", str(html), "--out", str(out),
                        "--width", str(width), "--targets", str(targets_file), "--boxes-out", str(boxes_out)],
                       cwd=ws.root, env={**os.environ, **ws.env()}, capture_output=True, text=True, encoding="utf-8")
    return r.returncode == 0


def compare_shots(ws, d, w):
    r = subprocess.run([PY, "-I", str(HERE / "edit_check.py"), "compare", "--before", str(d / f"before-{w}.png"),
                        "--after", str(d / f"after-{w}.png"), "--boxes", str(d / f"before-{w}.json"),
                        "--boxes-after", str(d / f"after-{w}.json"), "--out", str(d / f"diff-{w}.json"),
                        "--sheet", str(d / f"sheet-{w}.png")],
                       cwd=ws.root, capture_output=True, text=True, encoding="utf-8")
    try:
        return json.loads((d / f"diff-{w}.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"ok": False, "error": (r.stderr or r.stdout)[-300:]}


def edit_brief(ws, pins, extra=""):
    page = ws.state["page"]
    lines = [f"[харнесс] Правка владельца на готовой странице site/{page}/ (оформление — design/{page}/). Это не шаг "
             "пайплайна: STATUS.md, DECISIONS.md и артефакты шагов не меняешь, flow.py не запускаешь.", "",
             "## Что поменять"]
    for i, pin in enumerate(pins, 1):
        where = pin.get("selector", "?")
        if pin.get("of", 1) and pin.get("of", 1) > 1:
            where += f" (номер {pin.get('nth', 1)} из {pin['of']})"
        if pin.get("file"):
            where += f", файл {pin['file']}" + (f", строка {pin['line']}" if pin.get("line") else "")
        lines += [f"{i}. Место: {where}", f"   Текст элемента: «{(pin.get('text') or '')[:200]}»",
                  f"   Фрагмент: {(pin.get('outerHTMLShort') or '')[:600]}",
                  f"   Владелец: «{pin.get('request', '')}»"]
    lines += ["", "## Правила",
              "- Меняй только эти места. Остальная страница должна остаться как была: харнесс сравнит снимки до и после.",
              "- Числа и обещания — только из FACTS.md. Движение — готовыми компонентами design-pipeline/motion. "
              "Растровых картинок интерфейса нет.",
              "- Не понял, что именно хочет владелец, — сделай самый вероятный вариант и скажи об этом одной строкой.",
              *([extra] if extra else []), "", "## Как закончить",
              f"Одна строка для владельца простыми словами, что сделано. Последней строкой «{ENDS_OK}»."]
    return "\n".join(lines)


def edit_turn(ws, payload):
    pins = payload.get("pins") or []
    if not pins:
        emit(ev="stuck", text="правка: не выбрано ни одного места на странице")
        return
    page = ws.state["page"]
    site = ws.root / "site" / page
    html = site / "index.html"
    if not html.exists():
        emit(ev="stuck", text="правка: страницы ещё нет, сначала её нужно собрать")
        return
    ws.state["edits"] = n = ws.state.get("edits", 0) + 1
    ws.save()
    d = ws.page / "artifacts" / "edit" / f"{n:02d}"
    d.mkdir(parents=True, exist_ok=True)
    (d / "pins.json").write_text(json.dumps(pins, ensure_ascii=False, indent=1), encoding="utf-8")
    shutil.copytree(site, d / "site-before", dirs_exist_ok=True)       # «Вернуть как было»
    targets = d / "targets.json"
    targets.write_text(json.dumps([{"selector": p.get("selector", "body"), "nth": p.get("nth", 1)} for p in pins],
                                  ensure_ascii=False), encoding="utf-8")
    widths = sorted({int(p.get("width") or 1440) for p in pins})[:2]
    shots = all(shoot(ws, html, d / f"before-{w}.png", w, targets, d / f"before-{w}.json") for w in widths)
    hc_before = set(harness_check(ws).splitlines())          # правка отвечает только за новые провалы проверки
    model = CFG["ladder"][min(1, len(CFG["ladder"]) - 1)]          # вкус: вторая ступень (Kimi, где она есть)
    cfg = {**CFG["defaults"], **EDIT_CFG}
    sess = ws.h / "sessions" / f"edit-{n:02d}.jsonl"
    emit(ev="stage", gate="edit", title="Правка на странице", model=model, attempt=1)
    final, st = run_stage(ws, "edit", edit_brief(ws, pins), model, cfg, sess)
    ws.ledger(kind="edit", n=n, model=model, **st)
    diffs = {}
    for attempt in range(2):
        hc = "\n".join(x for x in harness_check(ws).splitlines() if x not in hc_before and x.startswith("FAIL"))
        if shots:
            for w in widths:
                shoot(ws, html, d / f"after-{w}.png", w, targets, d / f"after-{w}.json")
                diffs[w] = compare_shots(ws, d, w)
        bad = [w for w, x in diffs.items() if not x.get("ok")]
        if attempt or (not bad and not hc):
            break
        why = [f"на ширине {w} изменилось и другое: " + ", ".join(
            f"<{b.get('tag')}{' #' + b['id'] if b.get('id') else ''}> ({b.get('why')})" for b in diffs[w].get(
                "blocks_changed", [])[:4]) for w in bad]
        fix = ("[харнесс] Проверка правки: " + "; ".join(why + ([hc.strip()] if hc else [])) +
               ". Верни остальное как было, меняй только выбранные места, и снова закончи «" + ENDS_OK + "».")
        final, s2 = run_stage(ws, "edit", fix, model, cfg, sess)
        ws.ledger(kind="edit_fix", n=n, model=model, **s2)
    said = [ln for ln in final.splitlines() if ln.strip() and ENDS_OK not in ln]
    ok = shots and diffs and all(x.get("ok") for x in diffs.values()) and not hc
    w0 = widths[0]
    sheet = d / f"sheet-{w0}.png"
    text = (said[-1] if said else "Поправил выбранные места.") + "\n" + f"Было / стало: {sheet.relative_to(ws.root)}"
    if shots and not ok:
        text += "\nИзменилось и что-то кроме выбранного — посмотрите внимательно."
    opts = [{"q": "", "options": [{"key": f"edit:keep:{n}", "label": "Оставить", "recommended": bool(ok)},
                                  {"key": f"edit:revert:{n}", "label": "Вернуть как было", "recommended": not ok}]}]
    ws.ledger(kind="edit_done", n=n, ok=bool(ok), diffs={str(k): v.get("ratio") for k, v in diffs.items()})
    emit(ev="owner", text=text, files=[str(sheet.resolve())] if sheet.exists() else [], options=opts)


def edit_answer(ws, text):
    """Кнопки после правки: edit:keep:N — оставить; edit:revert:N — вернуть папку страницы из копии до правки."""
    m = re.fullmatch(r"edit:(keep|revert):(\d+)", text.strip())
    if not m:
        return False
    n = int(m.group(2))
    if m.group(1) == "revert":
        src = ws.page / "artifacts" / "edit" / f"{n:02d}" / "site-before"
        site = ws.root / "site" / ws.state["page"]
        if src.is_dir():
            shutil.rmtree(site, ignore_errors=True)
            shutil.copytree(src, site)
            ws.ledger(kind="edit_revert", n=n)
            emit(ev="done", text="Вернул страницу как было до правки.")
        else:
            emit(ev="stuck", text="правка: копии до правки нет, вернуть нечего")
    else:
        ws.ledger(kind="edit_keep", n=n)
        emit(ev="done", text="Оставил правку.")
    return True


def say(a):
    ws = WS(a.ws)
    if getattr(a, "edit", None):
        src = Path(a.edit)
        return edit_turn(ws, json.loads(src.read_text(encoding="utf-8") if src.exists() else a.edit))
    if a.text and edit_answer(ws, a.text):
        return
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
    if a.retry:                                          # «Попробовать ещё раз» в приложении: лестница шагов заново
        ws.state.pop("attempts", None)
        ws.save()
    notes = list(ws.state.pop("carry_notes", []))
    marked = marks_note(files)
    if marked:
        notes.append(marked)
    ws.state["transport_errors"] = 0
    if a.text and ws.state.pop("judge_cap_asked", False):
        fix = re.match(r"\s*[бb6]\b", a.text.lower()) or "исправ" in a.text.lower()
        if fix:
            ws.state["judge_bonus"] = ws.state.get("judge_bonus", 0) + 1
            ws.state["judge_capped"] = False
            notes.append(f"Владелец после лимита судьи ответил «{a.text}»: исправь находки Blocker и Critical, "
                         "подтверждённые кадром, перезапусти гейт и закончи «ЭТАП ГОТОВ». Харнесс даст судье ещё раунд.")
        else:
            notes.append(f"Владелец после лимита судьи ответил «{a.text}»: если это согласие выложить как есть, запиши в "
                         f"STATUS.md строку «ВЫБОР 7j: принять как есть · «{a.text}» · {dt.date.today()}» (его слова "
                         "дословно), запусти flow.py и закончи «ЭТАП ГОТОВ». Если ответ про другое — сделай, что он "
                         "просит, и закончи сообщением ему.")
        ws.save()
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
        # судью зовёт харнесс: когда в шаге 7 не хватает только судьи. Новый раунд — только по новым снимкам:
        # после FAIL сначала правит агент (E9: раунд 2 шёл сразу по тем же снимкам и сжёг лимит). Исключение —
        # PASS в раунде 1: пайплайн требует второй раунд, его можно по тем же снимкам.
        judge_now = False
        if gate == "7" and probs and all("судь" in x for x in probs):
            fp = snapshots_fp(ws)
            last = ws.state.get("judge_last") or {}
            judge_now = last.get("fp") != fp or (last.get("verdict") == "PASS" and last.get("round", 0) < 2)
            if ws.state.get("judge_capped"):                 # лимит исчерпан и владелец ответил: решает он, не судья
                judge_now = False
            if not judge_now and ws.state.get("judge_capped"):
                pass                                       # указание по ответу владельца уже в notes
            elif not judge_now:
                notes = [f"Судья (раунд {last.get('round')}, {last.get('verdict')}) смотрел эти снимки: его находки в "
                         "artifacts/judge/JUDGE.md. Исправь в коде находки, подтверждённые кадром (Blocker и Critical — "
                         "обязательно), отметь их в колонке «Статус», перезапусти гейт и закончи «ЭТАП ГОТОВ». "
                         "Судью позовёт харнесс по новым снимкам."]
        if judge_now:
            code, out = run_judge(ws)
            emit(ev="note", text=f"судья: {out[-300:]}")
            if code == 0:
                try:
                    j = json.loads(out.strip().splitlines()[-1])
                except (ValueError, IndexError):
                    j = {}
                ws.state["judge_last"] = {"fp": snapshots_fp(ws), "verdict": j.get("verdict"), "round": j.get("round")}
                ws.save()
                continue
            if code == 3:
                # шаг 7 не пройти, пока судья FAIL, а показывать страницу до шага 7 пайплайн не даёт: пишет харнесс
                text, files = judge_cap_message(ws)
                h7 = ws.state.setdefault("attempts", {}).setdefault("g7", {"n": 0, "rung": 0, "last": None})
                h7["waiting_owner"] = True
                ws.state["judge_cap_asked"] = True
                ws.state["judge_capped"] = True
                ws.state["outbox"] = ws.state.get("outbox", 0) + 1
                sent = ws.h / "sent"
                sent.mkdir(exist_ok=True)
                (sent / f"{ws.state['outbox']:02d}.md").write_text(text + "\n", encoding="utf-8")
                ws.save()
                emit(ev="owner", text=text, files=files, options=options_of(text))
                return
            elif code == 4:
                notes = ["Судья не смотрит старые снимки: перезапусти гейт (команда выше), потом «ЭТАП ГОТОВ»."]
            elif code == 5:
                emit(ev="stuck", text="Проверить страницу некому: шлюз не отдаёт модель уровня Opus, а проверку картинки "
                                      "слабой модели не доверяем. Когда она появится, нажмите «Попробовать ещё раз».")
                return
            else:
                emit(ev="stuck", text="судья не ответил: " + out[-200:])
                return
        # шаг 5 за флагом: прототипы параллельно одним вызовом, дальше обычная сессия смотрит лист и спрашивает
        if (gate == "5" and cfg.get("parallel") and not ws.state.get("parallel5")
                and any("05-proto/" in x for x in probs)):
            calls = parallel_protos(ws, cfg)
            ws.state["parallel5"] = {"calls": calls}
            ws.save()
            if calls:
                notes.append("Прототипы A и B (05-proto/a, 05-proto/b) и лист 05-compare.png собрал харнесс параллельно. "
                             "Не переделывай их: открой лист, проверь flow.py и спроси владельца инструментом ask_owner, "
                             "какой берём (со своей рекомендацией).")
                continue
        if gate == "5" and (ws.state.get("parallel5") or {}).get("calls"):
            # общий бюджет шага не больше прежнего: вызовы прототипов уже потрачены
            cfg["max_calls"] = max(10, cfg["max_calls"] - ws.state["parallel5"]["calls"])
        # попытки и лестница моделей по шагу
        key = f"g{gate}"
        hist = ws.state.setdefault("attempts", {}).setdefault(key, {"n": 0, "rung": cfg["start"], "last": None})
        # нет прогресса = те же замечания flow И не менялся ни код страницы, ни артефакты шага (E9: на шаге 7 текст
        # «судья: FAIL» одинаков в каждом раунде, хотя агент честно правил страницу)
        work_fp = tree_fp(ws.root / "site", ws.page)
        if hist["last"] == probs and hist.get("work_fp") == work_fp and hist["n"] >= cfg["max_attempts"]:
            hist["rung"] += 1
            hist["n"] = 0
            ws.ledger(kind="escalate", gate=gate, to=hist["rung"], why=probs[:3])
        if hist["rung"] >= len(CFG["ladder"]):
            emit(ev="stuck", text=f"шаг {gate} не получился ни на одной модели лестницы: {probs[:3]}")
            ws.save()
            return
        model = CFG["ladder"][hist["rung"]]
        if marked:                                   # красное на картинке видит только модель со зрением
            model = vision_model(CFG["ladder"], hist["rung"])
        if hist.get("work_fp") != work_fp:                       # был прогресс: попытки с нуля на той же ступени
            hist["n"] = 0
        hist["n"] += 1
        hist["last"] = probs
        hist["work_fp"] = work_fp
        ws.save()
        sess = ws.h / "sessions" / f"{gate}-{int(time.time())}.jsonl"
        emit(ev="stage", gate=gate, title=nx.get("title"), model=model, attempt=hist["n"])
        final, st = run_stage(ws, gate, brief(ws, gate, fl, cfg, notes, model), model, cfg, sess)
        ws.ledger(kind="stage", gate=gate, model=model, attempt=hist["n"], **st,
                  lessons=[x["id"] for x in lessons_for(gate, model)],
                  end="owner" if st.get("ask") or TO_OWNER in final else ("ok" if ENDS_OK in final else "other"))
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
        card = ask_card(st.get("ask"))
        if card or TO_OWNER in final:
            # кнопки — из вызова ask_owner; без него — разбор текста после «ВЛАДЕЛЬЦУ:» (запасной путь)
            text, options = card or (final.split(TO_OWNER, 1)[1].strip(), None)
            if hc:                                           # проверка харнесса провалена: владельцу не показываем
                continue
            fails = 0
            while True:
                op = second_opinion(ws, text, model, gate)
                if not op or op.get("verdict") != "FAIL" or fails >= CFG["checker_retries"]:
                    break
                fails += 1
                bad = [i for i in op.get("items", []) if not i.get("ok")]
                again = ("снова спроси его инструментом ask_owner" if card else f"снова закончи «{TO_OWNER}» и текстом")
                fix = ("[второе мнение харнесса, не владелец: сообщение владельцу НЕ ушло. Исправь это в работе и в "
                       f"сообщении, потом {again}]\n" +
                       "\n".join(f"- {i['check']}: {i['evidence']}" for i in bad))
                emit(ev="note", text="второе мнение вернуло сообщение: " + "; ".join(i["check"] for i in bad))
                f2, s2 = run_stage(ws, gate, fix, model, cfg, sess)
                ws.ledger(kind="fix", gate=gate, model=model, **s2)
                card2 = ask_card(s2.get("ask"))
                if card2:
                    text, options = card = card2
                elif TO_OWNER in f2:
                    text, options = f2.split(TO_OWNER, 1)[1].strip(), None
            if gate == "5":
                text, options = apply_pair_pick(text, options, pair_pick(ws))
            hist["waiting_owner"] = True
            ws.state["outbox"] = ws.state.get("outbox", 0) + 1
            sent = ws.h / "sent"                       # отправленное владельцу; outbox/ страницы — черновики агента
            sent.mkdir(exist_ok=True)
            (sent / f"{ws.state['outbox']:02d}.md").write_text(text + "\n", encoding="utf-8")
            shown = [str((ws.root / x).resolve()) for x in re.findall(r"[\w./\\-]+\.(?:png|jpe?g|mp4|webm|html)", text)
                     if (ws.root / x).exists()]
            ws.save()
            emit(ev="owner", text=text, files=shown, options=options if options is not None else options_of(text))
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
    s.add_argument("--files", nargs="*"); s.add_argument("--retry", action="store_true")
    s.add_argument("--edit", help="правка на готовой странице: JSON {pins:[{selector,nth,of,text,outerHTMLShort,file,"
                                  "line,request,width}]} или путь к файлу с ним")
    t = sp.add_parser("status"); t.add_argument("ws")
    a = ap.parse_args()
    {"init": init, "say": say, "status": status}[a.cmd](a)
