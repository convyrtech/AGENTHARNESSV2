# -*- coding: utf-8 -*-
"""flow: ворота процесса: смотрит артефакты страницы и называет ОДИН следующий шаг.

    python -I tools/flow.py --page design/<page>              где я и что делать дальше
    python -I tools/flow.py --page design/<page> --stage 6    можно ли начинать шаг 6 (все ворота до него)
    python -I tools/flow.py --page design/<page> --init       завести папку страницы из шаблонов
    python -I tools/flow.py --lint-message outbox/01.md [--page design/<page>]   проверить сообщение владельцу

Ворота по порядку: 0 паспорт, 0a вопросы владельцу, 1 эталон, 2 бренд, 2a смысл и факты, 3 референсы,
4 движение, 5 прототипы, 6 сборка, 7 проверки, 8 выкладка. Подробно: PIPELINE.md.

Выбор владельца пишется в STATUS.md строкой
    ВЫБОР 5: B · «берём второй, кнопку крупнее» · 2026-10-17
Цитата сверяется с перепиской Claude Code (~/.claude/projects/<папка проекта>/*.jsonl): она должна стоять
в сообщении человека, а не в ответе агента, в пределах суток от даты. Переписки нет: выход 2 (проверить человеку).

Выход: 0 всё нужное выполнено; 1 есть невыполненные ворота (печатается один следующий шаг);
2 ворота выполнены, но цитаты владельца сверить не с чем.
"""
import argparse
import datetime as dt
import difflib
import hashlib
import json
import os
import re
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _common as C  # noqa: E402

TOOLS = C.TOOLS_DIR
REPO = TOOLS.parent
TEMPLATES = REPO / "templates"
ORDER = ["0", "0a", "1", "2", "2a", "3", "4", "5", "6", "7", "8"]
TITLES = {"0": "Паспорт страницы (STATUS.md)", "0a": "Вопросы владельцу (не больше трёх, с вариантами)",
          "1": "Эталон и его разбор", "2": "Бренд из первоисточников", "2a": "Смысл и факты до текста",
          "3": "Референсы с оценками", "4": "Контракт движения до кода", "5": "Два разных прототипа и выбор",
          "6": "Сборка выбранного", "7": "Проверки числами и судья без кода", "8": "Выкладка"}
IMG = (".png", ".jpg", ".jpeg", ".webp")
FONT_EXT = (".ttf", ".otf", ".woff", ".woff2")
NONE_WORDS = {"нет", "none", "-", "—"}
# template gaps: «<дата>», «<URL>», «<N>»; not «кадр < 18 мс, FPS >= 55» (space after «<»)
PLACEHOLDER = re.compile(r"<(?=\S)(?:[^<>\n]{0,80}[а-яё][^<>\n]{0,80}|url|n|ms|\.\.\.|x)(?<=\S)>", re.I)
CHOICE = re.compile(r"^\s*[-*]?\s*ВЫБОР\s+([0-9A-Za-zА-Яа-я]{1,3})\s*:\s*(.+?)\s*·\s*«(.+)»\s*·\s*"
                    r"(\d{4}-\d{2}-\d{2})\s*$")
FIELD = re.compile(r"^\s*[-*]\s*([А-ЯЁA-Z][^:\n]{1,30}?)\s*:\s*(.*?)\s*$")
STATUS_FIELDS = ["Владелец", "Текст владельца", "Бренд", "Материалы владельца", "Решения", "Эталон", "Экранов",
                 "Новичок", "Исходники"]
ROLLBACK = re.compile(r"ln\s+-s|releases?/|git\s+(revert|reset|checkout)|rollback|симлинк|symlink|\bcurrent\b|"
                      r"[A-Z][A-Z0-9_]{2,}=\S|\S+[/\\]\S+|\.sh\b|\bcp\s|\bmv\s|docker|systemctl|kubectl|vercel", re.I)
LOOKALIKE = str.maketrans("ABCEHKMOPTX", "АВСЕНКМОРТХ")      # Latin capitals typed for Cyrillic option letters
LATER = re.compile(r"позже|потом|заполн|todo|tbd|когда будет|уточн", re.I)


# ---------- helpers ----------
def tool_cmd(name, args=""):
    return f"python -I {TOOLS / name} {args}".rstrip()


def rel(p, root):
    try:
        return str(Path(p).resolve().relative_to(root)).replace("\\", "/")
    except ValueError:
        return str(p)


def read(p):
    try:
        return Path(p).read_text(encoding="utf-8")
    except (FileNotFoundError, IsADirectoryError):
        return None


def placeholders(text):
    return sorted(set(m.group(0) for m in PLACEHOLDER.finditer(text or "")))


tables = C.md_tables


def section(text, title_re):
    """Body of the markdown section whose heading matches title_re (up to the next heading of same or higher level)."""
    lines = (text or "").splitlines()
    for i, ln in enumerate(lines):
        m = re.match(r"^(#{1,6})\s+(.*)$", ln)
        if m and re.search(title_re, m.group(2), re.I):
            lvl, body = len(m.group(1)), []
            for nxt in lines[i + 1:]:
                m2 = re.match(r"^(#{1,6})\s+", nxt)
                if m2 and len(m2.group(1)) <= lvl:
                    break
                body.append(nxt)
            return "\n".join(body).strip()
    return None


def meaningful(s):
    s = re.sub(r"<!--.*?-->", "", s or "", flags=re.S).strip()
    return bool(s) and not PLACEHOLDER.search(s) and s not in ("...", "…")


def is_none(v):
    return (v or "").strip().lower().split(" ")[0].strip(".,;()") in NONE_WORDS


def count_images(d):
    d = Path(d)
    return len([p for p in d.rglob("*") if p.suffix.lower() in IMG]) if d.is_dir() else 0


def folder_hash(target):
    p = Path(target)
    if not p.exists():
        return None
    base = p if p.is_dir() else p.parent
    h = hashlib.sha256()
    for f in sorted(x for x in base.rglob("*") if x.is_file()):
        h.update(str(f.relative_to(base)).replace("\\", "/").encode())
        h.update(f.read_bytes())
    return h.hexdigest()


def glob_to_re(g):
    g = g.strip().replace("\\", "/").lstrip("./")
    out, i = "", 0
    while i < len(g):
        if g.startswith("**/", i):
            out += "(?:.*/)?"
            i += 3
        elif g.startswith("**", i):
            out += ".*"
            i += 2
        elif g[i] == "*":
            out += "[^/]*"
            i += 1
        elif g[i] == "?":
            out += "[^/]"
            i += 1
        else:
            out += re.escape(g[i])
            i += 1
    return re.compile(out + "$", re.I)


def source_globs(value):
    return [g.strip() for g in re.split(r"[,;]\s*", value or "") if g.strip() and not is_none(g)]


def source_files(root, value):
    pats = [glob_to_re(g) for g in source_globs(value)]
    if not pats:
        return []
    files = []
    for dp, dns, fns in os.walk(root):
        dns[:] = [d for d in dns if d not in (".git", "node_modules", "artifacts", "dist", ".next")]
        for fn in fns:
            r = rel(Path(dp) / fn, root)
            if any(p.match(r) for p in pats):
                files.append(Path(dp) / fn)
    return files


def newest_mtime(files):
    return max((f.stat().st_mtime for f in files), default=0.0)


# ---------- snapshot of the page code: writes the hook cannot see (generators, git apply, python -c) ----------
BASELINE = ".flow-baseline.json"


def utc_now():
    return dt.datetime.now(dt.timezone.utc)


def tracked_files(p):
    """Page code: files of «Исходники» plus GUARD files that no other page declares as its own."""
    mine = source_files(p.root, p.f("Исходники"))
    guard_t = read(p.root / "design" / "GUARD.txt") or ""
    guard = [ln.strip() for ln in guard_t.splitlines() if ln.strip() and not ln.strip().startswith("#")]
    if not guard:
        return mine
    others = []
    for st in (p.root / "design").glob("*/STATUS.md"):
        if st.parent.resolve() != p.dir:
            m = re.search(r"(?m)^\s*[-*]\s*Исходники\s*:\s*(.*)$", read(st) or "")
            others += [glob_to_re(g) for g in source_globs(m.group(1) if m else "")]
    extra = [f for f in source_files(p.root, ", ".join(guard))
             if not any(o.match(rel(f, p.root)) for o in others)]
    return sorted(set(mine) | set(extra))


def file_state(f, data):
    """sha256 of a file, re-hashed only when its mtime or size changed."""
    st = f.stat()
    key = rel(f, data["_root"])
    cached = data.setdefault("stat", {}).get(key)
    if cached and cached[0] == st.st_mtime and cached[1] == st.st_size:
        return cached[2], st.st_mtime
    sha = hashlib.sha256(f.read_bytes()).hexdigest()
    data["stat"][key] = [st.st_mtime, st.st_size, sha]
    data["_dirty"] = True
    return sha, st.st_mtime


def update_baseline(p):
    """design/<page>/.flow-baseline.json: the page code as it was when the page was started («init»: files that
    existed before, by mtime) and when each later version of every file was first seen («seen»). Runs on --init and
    on every flow / hook / lint run, so code written by any means before the owner's choice leaves a trace."""
    if not p.status_text or not p.dir.is_dir():
        return
    path = p.dir / BASELINE
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        new = False
    except (OSError, ValueError):
        progressed = set(p.choices) & {"2a", "3", "5s", "5", "7", "8"} or p.path("05-proto").exists()
        if progressed:                      # a deleted snapshot is not re-made from today's code: gate 6 says so
            return
        data, new = {"created": utc_now().isoformat(), "init": {}, "seen": {}, "stat": {}}, True
    data["_root"], data["_dirty"] = p.root, new
    created = dt.datetime.fromisoformat(data["created"])
    now = utc_now().isoformat()
    for key in [k for k in data["seen"] if not (p.root / k).exists()]:   # rolled back: the history goes with it
        data["seen"].pop(key)
        data.setdefault("stat", {}).pop(key, None)
        data["_dirty"] = True
    for f in tracked_files(p):
        key = rel(f, p.root)
        sha, mtime = file_state(f, data)
        if key not in data["init"] and key not in data["seen"]:
            if new or dt.datetime.fromtimestamp(mtime, dt.timezone.utc) < created:
                data["init"][key] = sha                           # existed before the page was started
                data["_dirty"] = True
                continue
        if sha != data["init"].get(key) and sha not in data["seen"].setdefault(key, {}):
            data["seen"][key][sha] = now
            data["_dirty"] = True
    if data.pop("_dirty"):
        data.pop("_root")
        try:
            path.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
        except OSError:
            pass
    data.pop("_root", None)


def code_before_choice(p, t5):
    """Files of the page code that changed from the snapshot before the owner's choice (ВЫБОР 5) was made."""
    try:
        data = json.loads((p.dir / BASELINE).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    data["_root"] = p.root
    bad = []
    for f in tracked_files(p):
        key = rel(f, p.root)
        sha, mtime = file_state(f, data)
        if sha == data["init"].get(key):
            continue
        times = [dt.datetime.fromtimestamp(mtime, dt.timezone.utc)]
        first = data["seen"].get(key, {}).get(sha)
        if first:
            times.append(dt.datetime.fromisoformat(first))
        if min(times) < t5:
            bad.append(key)
    return bad


# ---------- owner words and judge answers: Claude Code transcript and the owner's Telegram channel ----------
DROP_TAGS = ["system-reminder", "teammate-message", "local-command-stdout", "local-command-stderr", "bash-stdout",
             "bash-stderr", "task-notification", "cross-session-message", "local-command-caveat", "command-name",
             "command-message"]
DROP_RE = re.compile(r"<(" + "|".join(DROP_TAGS) + r")\b[^>]*>.*?</\1>", re.S)
SKIP_KEYS = ("toolUseResult", "isMeta", "isCompactSummary", "isVisibleInTranscriptOnly", "sourceToolUseID",
             "scheduledTaskId", "queuePriority", "turnCompanion")
JUDGE_MARK = "JUDGE-PROMPT v2"          # stable line of templates/JUDGE-PROMPT.md; the judge call must carry it
SHOT_RE = re.compile(r"\.(png|jpe?g|webp)\b", re.I)
AUDIO = (".ogg", ".oga", ".opus", ".mp3", ".m4a", ".wav")


norm_words = C.norm_words


def slug(path):
    return re.sub(r"[^A-Za-z0-9]", "-", str(Path(path).resolve()))


def transcript_dirs(project_root, explicit=None):
    """Transcript folders of THIS project only: ~/.claude/projects/<slug of the project root>. The current folder
    counts only when it is the project root: another project's messages must never approve this one."""
    if explicit:
        return [Path(explicit)]
    env = os.environ.get("FLOW_TRANSCRIPTS")
    if env:
        return [Path(env)]
    root = Path(project_root).resolve()
    d = Path.home() / ".claude" / "projects" / slug(root)
    return [d] if d.is_dir() else []


def parse_ts(s):
    """Aware datetime from a transcript «2026-10-17T15:48:25.000Z» or None."""
    try:
        return dt.datetime.fromisoformat((s or "").replace("Z", "+00:00"))
    except ValueError:
        return None


def content_text(c):
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        return "\n".join(b.get("text", "") for b in c if isinstance(b, dict) and b.get("type") == "text")
    return ""


def human_text(o):
    """(iso timestamp, normalized text) if this transcript entry is a message typed by the human, else None.
    Tool results, skill text, compaction summaries, scheduled prompts, task notifications and teammate messages
    are not owner words."""
    if o.get("type") != "user" or o.get("isSidechain") or any(k in o for k in SKIP_KEYS):
        return None
    if isinstance(o.get("origin"), dict) and o["origin"].get("kind") not in (None, "human"):
        return None
    c = (o.get("message") or {}).get("content")
    if isinstance(c, list) and any(isinstance(b, dict) and b.get("type") == "tool_result" for b in c):
        return None
    text = norm_words(DROP_RE.sub(" ", content_text(c)))
    return (o.get("timestamp") or "", text) if text else None


AGENT_TOOLS = ("Agent", "Task")
SPAWNED = ("Spawned successfully", "Async agent launched")


def agent_answer(o, ids):
    """(answer text, is_judge) of a subagent, written by the harness, never by the main agent: the tool_result of an
    Agent/Task call (foreground) or the <result> of the task-notification the harness sends when a background agent
    finishes (origin.kind = task-notification, <tool-use-id> of that call). A call is a judge call only if its prompt
    carries JUDGE_MARK and names at least one snapshot file. ids: {tool_use_id: is_judge}."""
    msg = o.get("message") or {}
    if o.get("type") == "assistant":
        for b in msg.get("content") or []:
            if isinstance(b, dict) and b.get("type") == "tool_use" and b.get("name") in AGENT_TOOLS:
                prompt = str((b.get("input") or {}).get("prompt") or "")
                ids[b.get("id")] = JUDGE_MARK in prompt and bool(SHOT_RE.search(prompt))
        return None
    if o.get("type") != "user" or o.get("isSidechain"):
        return None
    c = msg.get("content")
    if isinstance(c, list):
        for b in c:
            if isinstance(b, dict) and b.get("type") == "tool_result" and b.get("tool_use_id") in ids:
                t = content_text(b.get("content"))
                if t.strip() and not t.lstrip().startswith(SPAWNED):
                    return t, ids[b["tool_use_id"]]
        return None
    if not isinstance(c, str) or not c.lstrip().startswith("<task-notification>"):
        return None
    origin = o.get("origin")
    if isinstance(origin, dict) and origin.get("kind") != "task-notification":
        return None
    m = re.search(r"<tool-use-id>(\S+?)</tool-use-id>", c)
    r = re.search(r"<result>(.*?)</result>", c, re.S)
    return (r.group(1), ids[m.group(1)]) if m and r and m.group(1) in ids else None


def scan_line(line, cache):
    if '"user"' not in line and not any(f'"{n}"' in line for n in AGENT_TOOLS):
        return
    try:
        o = json.loads(line)
    except ValueError:
        return
    ans = agent_answer(o, cache["ids"])
    if ans:
        if ans[1]:
            cache["judges"].append([o.get("timestamp") or "", ans[0]])
        return
    h = human_text(o)
    if h:
        cache["msgs"].append(list(h))


def edge_hash(fh, offset):
    """Hash of the first and the last 4 KB before offset: tells an appended transcript from a rewritten one."""
    fh.seek(0)
    head = fh.read(min(offset, 4096))
    fh.seek(max(0, offset - 4096))
    tail = fh.read(min(offset, 4096))
    return hashlib.sha1(head + b"|" + tail).hexdigest()


CACHE_VERSION = 3


def scan_transcripts(dirs):
    """Owner messages [(aware datetime|None, normalized text)] and judge answers [(aware datetime|None, raw text)]
    from top-level *.jsonl (subagent transcripts live in subfolders: skipped). Transcripts are append-only, so each
    file is parsed incrementally from a cached byte offset."""
    import tempfile
    cache_dir = Path(tempfile.gettempdir()) / "design-pipeline-flow-cache"
    cache_dir.mkdir(exist_ok=True)
    msgs, judges = [], []
    for d in dirs:
        for f in sorted(Path(d).glob("*.jsonl")):
            cf = cache_dir / (hashlib.sha1(str(f.resolve()).encode()).hexdigest() + ".json")
            try:
                cache = json.loads(cf.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                cache = {}
            size = f.stat().st_size
            with open(f, "rb") as fh:
                off = cache.get("offset", 0)
                if cache.get("v") != CACHE_VERSION or off > size or edge_hash(fh, off) != cache.get("edge"):
                    cache, off = {"v": CACHE_VERSION, "offset": 0, "msgs": [], "judges": [], "ids": {}}, 0
                fh.seek(off)
                chunk = fh.read() if size > off else b""
                end = chunk.rfind(b"\n") + 1          # a half-written last line waits for the next run
                for raw in chunk[:end].split(b"\n"):
                    scan_line(raw.decode("utf-8", errors="replace"), cache)
                cache["offset"] = off + end
                cache["edge"] = edge_hash(fh, cache["offset"])
            if end:
                try:
                    cf.write_text(json.dumps(cache, ensure_ascii=False), encoding="utf-8")
                except OSError:
                    pass
            msgs += [(parse_ts(ts), text) for ts, text in cache["msgs"]]
            judges += [(parse_ts(ts), text) for ts, text in cache["judges"]]
    return msgs, judges


def channel_messages(path, voice_dir=None):
    """Owner messages from the bot's messages.jsonl: {"id","date":"20261017-174825","text","forward_from","files"}.
    A voice message counts only through its transcription: <voice>.txt next to the audio file, or <id>.txt /
    <audio stem>.txt in the «Расшифровки голоса» folder. Dates are local time."""
    path = Path(path)
    out = []
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeDecodeError):
        return out
    for ln in lines:
        try:
            o = json.loads(ln)
        except ValueError:
            continue
        if not isinstance(o, dict):
            continue
        try:
            ts = dt.datetime.strptime(str(o.get("date", "")), "%Y%m%d-%H%M%S").astimezone()
        except ValueError:
            ts = None
        texts = [str(o.get("text") or "")]
        for f in o.get("files") or []:
            fp = Path(str(f))
            if fp.suffix.lower() not in AUDIO:
                continue
            fp = fp if fp.is_absolute() else path.parent / fp
            cands = [fp.with_suffix(".txt")]
            if voice_dir:
                cands += [Path(voice_dir) / f"{o.get('id')}.txt", Path(voice_dir) / f"{fp.stem}.txt"]
            for c in cands:
                if c.is_file():
                    texts.append(c.read_text(encoding="utf-8", errors="replace"))
                    break
        text = norm_words(" ".join(texts))
        if text:
            out.append((ts, text))
    return out


def born(path):
    """When the artifact first appeared on disk: creation time where the OS keeps it, else mtime."""
    path = Path(path)
    st = path.stat()
    t = getattr(st, "st_birthtime", None)
    if t is None and os.name == "nt":
        t = st.st_ctime
    if t is None:
        # Linux keeps no creation time and mtime moves on every edit: remember the first time we saw the file.
        reg = path.parent / ".flow-born.json"
        try:
            seen = json.loads(reg.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            seen = {}
        t = seen.get(path.name)
        if t is None or st.st_mtime < t:
            t = st.st_mtime
            seen[path.name] = t
            try:
                reg.write_text(json.dumps(seen, ensure_ascii=False, indent=1), encoding="utf-8")
            except OSError:
                pass
    return dt.datetime.fromtimestamp(t, dt.timezone.utc)


def short_quote(quote):
    return len(quote.strip()) < 12 or len(norm_words(quote).split()) <= 2


class Owner:
    def __init__(self, project_root, explicit=None, channel=None, voice_dir=None):
        self.dirs = transcript_dirs(project_root, explicit)
        self.explicit = explicit
        self.channel = Path(channel) if channel else None
        self.voice_dir = voice_dir
        self._msgs = self._judges = None

    @property
    def transcripts(self):
        return bool(self.dirs) and any(any(Path(d).glob("*.jsonl")) for d in self.dirs)

    @property
    def available(self):
        return self.transcripts or bool(self.channel and self.channel.is_file())

    def _load(self):
        if self._msgs is None:
            self._msgs, self._judges = scan_transcripts(self.dirs) if self.transcripts else ([], [])
            if self.channel and self.channel.is_file():
                self._msgs += channel_messages(self.channel, self.voice_dir)

    def judge_answers(self):
        """[(aware datetime|None, raw text)] of judge subagents, or None without a transcript."""
        if not self.transcripts:
            return None
        self._load()
        return self._judges

    def said(self, quote, date, after=None):
        """When found: the message time (aware datetime), or True if the message has no time. False when not found,
        None when there is nothing to compare with.
        Long quote: inside a human message within a day of `date`. Short quote («да», «B», «берём Б»): the WHOLE
        message, sent after `after` (when the artifact the owner answers appeared)."""
        if not self.available:
            return None
        self._load()
        q = norm_words(quote)
        if not q:
            return False
        try:
            day = dt.date.fromisoformat(date)
        except ValueError:
            return False
        short = short_quote(quote)
        if short and after is None:
            return False
        for ts, text in self._msgs:
            if ts is not None and abs((ts.astimezone().date() - day).days) > 1:
                continue
            if short:
                if text == q and ts is not None and ts > after:
                    return ts
            elif re.search(r"(?:^| )" + re.escape(q) + r"(?: |$)", text):
                return ts or True
        return False


# ---------- page state ----------
# what the owner answers at each gate: a short answer must come after this file appeared
ANSWERS_TO = {"в1": "00-intake.md", "в2": "00-intake.md", "в3": "00-intake.md", "0s": "00-intake.md",
              "1": "01-candidates.png",
              "2": "02-directions.png", "2a": "MESSAGE.md", "3": "03-references.md", "5s": "05-storyboard.png",
              "5": "05-compare.png", "7": "artifacts/design-gate.json", "8": "artifacts/judge/JUDGE.md"}


def gate_key(gid):
    """«В1» typed with Latin B, «2а»/«5с» with Cyrillic letters: one key."""
    g = gid.strip().lower()
    return g.translate(str.maketrans({"b": "в", "а": "a", "с": "s"}))


class Page:
    def __init__(self, page_dir, owner_transcripts=None):
        self.dir = Path(page_dir).resolve()
        self.root = self.dir.parent.parent if self.dir.parent.name == "design" else self.dir.parent
        self.status_text = read(self.dir / "STATUS.md") or ""
        self.fields = {}
        for ln in self.status_text.splitlines():
            m = FIELD.match(ln)
            if m and m.group(1) not in self.fields:
                self.fields[m.group(1).strip()] = re.sub(r"\s+\(.*?\)\s*$", "", m.group(2)).strip()
        self.choices = {}
        self.bad_choice_lines = []
        for ln in self.status_text.splitlines():
            if "ВЫБОР" not in ln:
                continue
            m = CHOICE.match(ln)
            if not m:
                if re.match(r"^\s*[-*]?\s*ВЫБОР\s", ln):
                    self.bad_choice_lines.append(ln.strip())
                continue
            self.choices[gate_key(m.group(1))] = {"value": m.group(2).strip(), "quote": m.group(3).strip(),
                                         "date": m.group(4), "line": ln.strip()}
        chan = self.f("Канал владельца")
        voice = self.f("Расшифровки голоса")
        self.owner = Owner(self.root, owner_transcripts,
                           channel=self.root / chan if meaningful(chan) and not is_none(chan) else None,
                           voice_dir=self.root / voice if meaningful(voice) and not is_none(voice) else None)
        self.unverified = []
        update_baseline(self)

    def f(self, name):
        return self.fields.get(name, "")

    def path(self, name):
        return self.dir / name

    def screens(self):
        m = re.match(r"\d+", self.f("Экранов"))
        return int(m.group(0)) if m else 0

    def decisions_path(self):
        v = self.f("Решения")
        return self.root / "design" / "DECISIONS.md" if is_none(v) else self.root / v

    def needs_storyboard(self):
        """Whole-page storyboard is required unless the OWNER confirmed a one-screen page (ВЫБОР 0s, his words).
        The agent's own «Экранов: 1» does not lift it. Unverifiable confirmation counts as single but unverified."""
        if self.screens() >= 3:
            return True
        c = self.choices.get("0s")
        if not c:
            return True
        art = self.dir / ANSWERS_TO["0s"]
        said = self.owner.said(c["quote"], c["date"], born(art) if art.exists() else None)
        if said is None:
            if "0s" not in self.unverified:
                self.unverified.append("0s")
            return False
        return not said

    def choice(self, gid, problems, what, allowed=None):
        """Owner choice line for gate gid; checks format, allowed value and the quote in the transcript."""
        c = self.choices.get(gate_key(gid))
        if not c:
            problems.append(f"нет строки выбора владельца: «ВЫБОР {gid}: <что выбрано> · «<слова владельца дословно>» · "
                            f"ГГГГ-ММ-ДД» в STATUS.md ({what})")
            return None
        if allowed and not re.match(allowed, c["value"], re.I):
            problems.append(f"ВЫБОР {gid}: «{c['value']}» не из допустимых вариантов ({allowed})")
        art = self.dir / ANSWERS_TO.get(gate_key(gid), "STATUS.md")
        after = born(art) if art.exists() else None
        said = self.owner.said(c["quote"], c["date"], after)
        if said is False and short_quote(c["quote"]):
            when = f"после {after.astimezone():%d.%m %H:%M}" if after else "(нет файла " + art.name + ")"
            problems.append(f"ВЫБОР {gid}: короткий ответ «{c['quote']}» засчитывается, только если это ВСЁ сообщение "
                            f"человека целиком и оно пришло {when}, когда появился {art.name}. Иначе процитируй его "
                            "сообщение длиннее, слово в слово.")
        elif said is False:
            problems.append(f"ВЫБОР {gid}: слов «{c['quote']}» нет в сообщениях человека за {c['date']} (±1 день). "
                            "Пиши только то, что владелец написал сам, слово в слово. Свой пересказ не годится.")
        elif said is None:
            self.unverified.append(gid)
        c["said_at"] = said if isinstance(said, dt.datetime) else None
        c["verified"] = bool(said)
        return c


# ---------- gates ----------
def g0(p):
    pr = []
    if not p.status_text:
        return pr + ["нет STATUS.md"], {
            "do": "Заведи папку страницы из шаблонов и заполни паспорт в STATUS.md.",
            "cmd": tool_cmd("flow.py", f"--page {p.dir} --init")}
    for k in STATUS_FIELDS:
        v = p.f(k)
        if not meaningful(v):
            pr.append(f"в STATUS.md не заполнено «- {k}: ...»")
    if meaningful(p.f("Решения")) and not p.decisions_path().exists():
        if is_none(p.f("Решения")):
            pr.append(f"файла решений нет: заведи его командой  {tool_cmd('flow.py', f'--page {p.dir} --init')}  "
                      f"(создаст design/DECISIONS.md из шаблона) и оставь «- Решения: нет» или впиши путь")
        else:
            pr.append(f"файл решений «{p.f('Решения')}» не найден от корня проекта {p.root} "
                      f"(напиши «нет», и --init создаст design/DECISIONS.md)")
    mat = p.f("Материалы владельца").lower()
    if meaningful(mat) and mat.split()[0].strip(".,") not in ("есть", "нет", "ждём", "ждем"):
        pr.append("«Материалы владельца:» только «есть», «нет» или «ждём»")
    for k in ("Текст владельца", "Бренд"):
        v = p.f(k)
        if meaningful(v) and not is_none(v):
            for part in re.split(r"[,;]\s*", v):
                if part and not re.match(r"https?://", part) and not (p.root / part).exists():
                    pr.append(f"«{k}: {part}» не найден от корня проекта (или напиши «нет»)")
    if p.f("Экранов") and not re.match(r"\d+$", p.f("Экранов")) and not is_none(p.f("Экранов")):
        pr.append("«Экранов:» число или «нет» (не знаешь: «нет», тогда раскадровка обязательна)")
    if p.f("Новичок") and p.f("Новичок").lower() not in ("да", "нет"):
        pr.append("«Новичок:» только «да» или «нет»")
    if p.bad_choice_lines:
        pr.append("строки ВЫБОР не по формату «ВЫБОР N: что · «цитата» · ГГГГ-ММ-ДД»: " + " | ".join(p.bad_choice_lines[:3]))
    return pr, {"do": "Заполни паспорт: кто владелец, где его текст, где бренд, файл решений, эталон, сколько экранов, "
                      "новичок ли гость, где будет код страницы. Не знаешь значения: напиши «нет», не выдумывай.",
                "tpl": TEMPLATES / "STATUS.md"}


def g0a(p):
    pr = []
    t = read(p.path("00-intake.md"))
    hint = {"do": "Задай владельцу не больше трёх вопросов с вариантами (кому, одно главное действие, настроение с "
                  "адресом-примером у каждого варианта), у каждого вопроса своя рекомендация, плюс одна строка "
                  "«пришлите, что есть: логотип, фото, адрес, цены». Спрашивай инструментом вопросов "
                  "(AskUserQuestion), все вопросы одним вызовом, не простынёй. Ответы запиши строками «ВЫБОР В1..В3» "
                  "в STATUS.md, итог буквами ответов.",
            "tpl": TEMPLATES / "INTAKE.md", "file": p.path("00-intake.md")}
    if t is None:
        return ["нет 00-intake.md"], hint
    first = re.search(r"(?m)^##\s*[ВB]\d", t)
    body_t = t[first.start():] if first else t                 # the service block above the questions is not checked
    qs = re.split(r"(?m)^##\s*[ВB](\d)\b", body_t)
    questions = [(qs[i], qs[i + 1]) for i in range(1, len(qs) - 1, 2)]
    if not questions:
        pr.append("в 00-intake.md нет вопросов «## В1. ...»")
    if len(questions) > 3:
        pr.append(f"вопросов {len(questions)}: владельцу не больше трёх")
    answers, verified = {}, True
    for n, body in questions:
        title = body.splitlines()[0] if body else ""
        opts = re.findall(r"(?m)^\s*[-*]\s*(?:\[[ xх]\]\s*)?[А-ЯA-Z][.)]\s+(.+)$", body.split("## ")[0])
        if not 2 <= len(opts) <= 4:
            pr.append(f"В{n}: вариантов {len(opts)}, нужно 2–4 (вопрос без вариантов владельцу не задаём)")
        rec = [o for o in opts if "рекомендую" in o.lower()]
        if len(rec) != 1:
            pr.append(f"В{n}: отметь ровно один вариант «(рекомендую)», сейчас {len(rec)}")
        if re.search(r"настроени", title, re.I):
            bare = [o for o in opts if not re.search(r"https?://\S+", o)]
            if bare:
                pr.append(f"В{n} (настроение): у каждого варианта нужен адрес-пример (https://...), без него "
                          f"{len(bare)}: «{bare[0][:40]}»")
        before = len(pr)
        c = p.choice(f"В{n}", pr, f"ответ на вопрос В{n}")
        if c and len(pr) == before:                # verified, or no transcript at all (then exit 2 and the hook blocks)
            answers[n] = c["value"].strip()[:1].upper()
        else:
            verified = False
    summ = section(body_t, r"итог") or ""
    for i, key in enumerate(("Кому", "Действие", "Настроение"), 1):
        m = re.search(rf"(?m)^\s*[-*]?\s*{key}\s*:\s*(.+)$", summ)
        val = m.group(1) if m else ""
        if not meaningful(val):
            pr.append(f"в «## Итог» 00-intake.md не заполнено «{key}:»")
        elif str(i) in answers and not re.search(
                rf"(?<![А-Яа-яA-Za-z]){re.escape(answers[str(i)].translate(LOOKALIKE))}(?![А-Яа-яA-Za-z])",
                val.translate(LOOKALIKE)):
            pr.append(f"«{key}:» в итоге должен ссылаться на ответ владельца, букву «{answers[str(i)]}» из ВЫБОР В{i}, "
                      f"а там «{val[:40]}»")
    if not verified and questions and not any("итог" in x.lower() for x in pr):
        pr.append("итог не засчитан: не все ответы ВЫБОР В1–В3 сверены со словами владельца")
    pr += [f"незаполненное место в 00-intake.md: {x}" for x in placeholders(body_t)[:3]]
    return pr, hint


def sheet_ok(p, png, need, label, pr):
    """Owner sheet made by compare_sheet.py: png + json sidecar with >= need variants, not stale."""
    side = png.with_suffix(".json")
    if not png.exists() or not side.exists():
        pr.append(f"нет листа {png.name} (+ {side.name}): собрать compare_sheet.py ({label})")
        return False
    try:
        data = json.loads(side.read_text(encoding="utf-8"))
    except ValueError:
        pr.append(f"{side.name} не читается")
        return False
    vs = data.get("variants", [])
    if len(vs) < need:
        pr.append(f"на листе {png.name} вариантов {len(vs)}, нужно {need}")
    for v in vs:
        if v.get("sha256") and v.get("path") and folder_hash(v["path"]) != v["sha256"]:
            pr.append(f"лист {png.name} устарел: вариант {v.get('label')} менялся после съёмки, пересними")
    return True


def g1(p):
    pr = []
    hint = {"do": "Разбери эталон: кадры на 390×844 и 1440 (≥ 12 позиций) и таблица «что даёт вау → на чём сделано → "
                  "берём/нет».", "tpl": TEMPLATES / "TEARDOWN.md", "file": p.path("01-teardown.md"),
            "cmd": tool_cmd("storyboard.py", f"--url <эталон> --at 0,400,...  --out {p.path('01-frames')}")}
    if is_none(p.f("Эталон")):
        if sheet_ok(p, p.path("01-candidates.png"), 3, "три кандидата в эталоны", pr):
            p.choice("1", pr, "какой эталон берём")
        if pr:
            hint = {"do": "Эталона нет. Найди три РАЗНЫХ живых сайта-кандидата, сними их одним листом и спроси "
                          "владельца, какой ближе. Открытый вопрос «какой эталон?» не задавать.",
                    "cmd": tool_cmd("compare_sheet.py", f"--variant <url1> --variant <url2> --variant <url3> "
                                                        f"--out {p.path('01-candidates.png')}"),
                    "tpl": TEMPLATES / "OWNER-MESSAGE.md"}
            return pr, hint
    t = read(p.path("01-teardown.md"))
    if t is None:
        return pr + ["нет 01-teardown.md"], hint
    wow = [rows for head, rows in tables(t) if any("вау" in h.lower() for h in head)]
    if not wow:
        # the template puts «вау» in the section heading, not in the table header: take the tables of that section
        sec = re.search(r"^#+[^\n]*вау[^\n]*\n(.*?)(?=^#+\s|\Z)", t, re.M | re.S | re.I)
        wow = [rows for head, rows in tables(sec.group(1))] if sec else []
    rows = [r for rows in wow for r in rows if any(re.search(r"берём|берем|нет", c, re.I) for c in r)]
    if len(rows) < 3:
        pr.append(f"в таблице «что даёт вау» строк с решением «берём/нет» {len(rows)}, нужно ≥ 3")
    n = count_images(p.path("01-frames"))
    if n < 12:
        pr.append(f"кадров эталона в 01-frames/ {n}, нужно ≥ 12")
    pr += [f"незаполненное место в 01-teardown.md: {x}" for x in placeholders(t)[:3]]
    return pr, hint


def g2(p):
    pr = []
    hint = {"do": "Бренд из первоисточников: палитра скриптом по пикселям, файлы шрифтов в fonts/ с кириллицей, "
                  "токены в 02-brand.md.", "tpl": TEMPLATES / "BRAND.md", "file": p.path("02-brand.md"),
            "cmd": tool_cmd("palette.py", f"<мудборд или логотип> --k 6 --out {p.dir}")}
    if p.f("Материалы владельца").lower().startswith(("ждём", "ждем")):
        return ["«Материалы владельца: ждём»: бренд не собирается из того, что ещё не пришло"], {
            "do": "Напомни владельцу одной строкой: «пришлите, что есть: логотип, фото, адрес, цены». Пришло: "
                  "положи файлы в проект, «Материалы владельца: есть», пути в «Бренд:». Ответил, что ничего нет: "
                  "«Материалы владельца: нет», «Бренд: нет», дальше три направления листом.",
            "tpl": TEMPLATES / "OWNER-MESSAGE.md"}
    if is_none(p.f("Бренд")):
        if sheet_ok(p, p.path("02-directions.png"), 3, "три разных визуальных направления", pr):
            p.choice("2", pr, "какое направление берём")
        if pr:
            return pr, {"do": "Материалов бренда нет. Сделай три РАЗНЫХ визуальных направления (цвет, шрифт, "
                              "характер), сними одним листом, спроси владельца одним вопросом с рекомендацией. "
                              "Чужой промо-ролик или шаблон брендом не считается.",
                        "cmd": tool_cmd("compare_sheet.py", "--variant <dir-a> --variant <dir-b> --variant <dir-c> "
                                                            f"--out {p.path('02-directions.png')}"),
                        "tpl": TEMPLATES / "OWNER-MESSAGE.md"}
    t = read(p.path("02-brand.md"))
    if t is None:
        pr.append("нет 02-brand.md")
    else:
        pr += [f"незаполненное место в 02-brand.md: {x}" for x in placeholders(t)[:3]]
    pals = [f for f in p.dir.rglob("palette*.json") if "artifacts" not in f.parts]
    good = []
    for f in pals:
        try:
            d = json.loads(f.read_text(encoding="utf-8"))
            if isinstance(d, dict) and isinstance(d.get("colors"), list) and d["colors"] and \
                    all(isinstance(c, dict) and "hex" in c for c in d["colors"]) and "naive_mean" in d:
                good.append(f)
        except ValueError:
            pass
    if not good:
        pr.append("нет палитры от palette.py (palette-*.json в папке страницы); палитру на глаз не принимаем")
    fonts = [f for f in p.path("fonts").rglob("*") if f.suffix.lower() in FONT_EXT] if p.path("fonts").is_dir() else []
    if not fonts:
        pr.append("нет файлов шрифтов в fonts/ (положи файлы, которые пойдут на страницу: проверим кириллицу)")
    else:
        import font_check
        for f in fonts:
            r = font_check.check(f)
            if r["missing"]:
                pr.append(f"шрифт {f.name}: нет кириллицы ({len(r['missing'])} букв, например {''.join(r['missing'][:6])})")
    return pr, hint


def g2a(p):
    pr = []
    hint = {"do": "До любого текста: MESSAGE.md (что это, кому, одно действие, три отличия с доказательством) и "
                  "FACTS.md (каждое обещание: работает сейчас или план). Покажи владельцу MESSAGE.md (лист 02a-message.png "
                  "или ссылка на MESSAGE.md) и получи «да». "
                  "Тексты на страницу не пишутся, пока этого нет.", "tpl": TEMPLATES / "MESSAGE.md",
            "file": p.path("MESSAGE.md")}
    m = read(p.path("MESSAGE.md"))
    f = read(p.path("FACTS.md"))
    if m is None:
        pr.append("нет MESSAGE.md")
    else:
        for title in (r"что это", r"кому|для кого", r"действие"):
            body = section(m, title)
            if not body or not meaningful(body):
                pr.append(f"в MESSAGE.md пустой раздел «{title.split('|')[0]}»")
        diffs = section(m, r"отличи") or ""
        items = re.findall(r"(?m)^\s*\d[.)]\s+(.+)$", diffs)
        if len(items) != 3:
            pr.append(f"в MESSAGE.md отличий {len(items)}, нужно ровно 3")
        for i, it in enumerate(items, 1):
            ev = re.search(r"доказательство\s*:\s*(.+)$", it, re.I)
            if not ev or not re.search(r"\d|https?://", ev.group(1)):
                pr.append(f"отличие {i}: нет «Доказательство: <замер, дата или ссылка>»")
        pr += [f"незаполненное место в MESSAGE.md: {x}" for x in placeholders(m)[:3]]
    if f is None:
        pr.append("нет FACTS.md")
        hint["tpl2"] = TEMPLATES / "FACTS.md"
    else:
        rows = C.facts_rows(f)
        if not rows:
            pr.append("в FACTS.md нет таблицы «| Обещание | Статус | Доказательство |» со строками")
        for prom, st, ev in rows:
            if st not in ("работает", "план"):
                pr.append(f"FACTS.md: у «{prom[:40]}» статус «{st}», допустимо «работает» или «план»")
            elif st == "работает" and not meaningful(ev):
                pr.append(f"FACTS.md: «{prom[:40]}» работает, но нет доказательства (замер, дата)")
        if m:
            import slop_lint as SL
            plan = [r[0] for r in rows if r[1] == "план"]
            for i, it in enumerate(re.findall(r"(?m)^\s*\d[.)]\s+(.+)$", section(m, r"отличи") or ""), 1):
                hit = SL.match_promise(it.split("·")[0], plan)
                if hit:
                    pr.append(f"отличие {i} опирается на обещание со статусом «план»: «{hit}». "
                              "План отличием не бывает: замени или дождись, пока заработает")
    if not pr:
        p.choice("2a", pr, "владелец ответил «да» на MESSAGE.md")
    return pr, hint


def g3(p):
    pr = []
    hint = {"do": "Найди ≥ 5 референсов, оцени каждый X/10 по осям задачи с кадром-доказательством, покажи владельцу "
                  "одним листом и спроси, что берём.", "tpl": TEMPLATES / "REFERENCES.md",
            "file": p.path("03-references.md")}
    t = read(p.path("03-references.md"))
    if t is None:
        return ["нет 03-references.md"], hint
    scored = 0
    for head, rows in tables(t):
        for r in rows:
            nums = [c for c in r[1:] if re.fullmatch(r"\s*(10|[0-9])(\s*/\s*10)?\s*", c)]
            if r and len(r) > 1 and meaningful(r[1]) and len(nums) >= 2:
                scored += 1
    if scored < 5:
        pr.append(f"референсов с оценками (≥ 2 оси, числа 0–10) {scored}, нужно ≥ 5")
    pr += [f"незаполненное место в 03-references.md: {x}" for x in placeholders(t)[:3]]
    if not pr:
        p.choice("3", pr, "что из референсов берём")
    return pr, hint


def g4(p):
    pr = []
    hint = {"do": "Контракт движения до кода: таблица «время → что видно → свойство → слой → easing», перф-бюджет, "
                  "reduced-motion.", "tpl": TEMPLATES / "MOTION-CONTRACT.md", "file": p.path("04-motion.md")}
    t = read(p.path("04-motion.md"))
    if t is None:
        return ["нет 04-motion.md"], hint
    rows = [r for head, rs in tables(t) if any("easing" in h.lower() for h in head) for r in rs
            if any(meaningful(c) for c in r)]
    if len(rows) < 2:
        pr.append(f"в таблице движения (с колонкой easing) строк {len(rows)}, нужно ≥ 2")
    perf = section(t, r"перф") or ""
    if not re.search(r"\d{2}", perf):
        pr.append("раздел «Перф-бюджет» без чисел (FPS, мс кадра, сдвиги)")
    rm = section(t, r"reduced") or ""
    if not meaningful(rm):
        pr.append("раздел reduced-motion пуст")
    pr += [f"незаполненное место в 04-motion.md: {x}" for x in placeholders(t)[:3]]
    return pr, hint


def html_text(path):
    try:
        return re.sub(r"\s+", " ", Path(path).read_text(encoding="utf-8", errors="replace"))
    except FileNotFoundError:
        return ""


def storyboard_problems(p):
    """Whole-page storyboard for pages of 3+ screens: fresh sheet in --mode page and a verified owner choice."""
    pr = []
    if sheet_ok(p, p.path("05-storyboard.png"), 2, "раскадровка всей страницы, 2 варианта", pr):
        try:
            mode = json.loads(p.path("05-storyboard.json").read_text(encoding="utf-8")).get("mode")
        except (ValueError, AttributeError):
            mode = None
        if mode != "page":
            pr.append("05-storyboard.png снят не в режиме --mode page (нужна вся длина страницы)")
        p.choice("5s", pr, "какую раскадровку берём")
    return pr


def g5(p):
    pr = []
    if p.needs_storyboard():
        why = (f"На странице {p.screens()} экранов" if p.screens() >= 3 else
               "Владелец не подтвердил своими словами, что страница в один экран (строка «ВЫБОР 0s»; число в "
               "паспорте от агента не считается)")
        hint = {"do": f"{why}: сначала раскадровка ВСЕЙ страницы, два варианта, одним "
                      "листом. Владелец выбирает, потом прототипы. Композицию держит один хозяин.",
                "tpl": TEMPLATES / "STORYBOARD.md",
                "cmd": tool_cmd("compare_sheet.py", f"--mode page --variant {p.path('05-storyboard/a/index.html')} "
                                                    f"--variant {p.path('05-storyboard/b/index.html')} "
                                                    f"--out {p.path('05-storyboard.png')}")}
        pr = storyboard_problems(p)
        if pr:
            return pr, hint
    a, b = p.path("05-proto/a/index.html"), p.path("05-proto/b/index.html")
    hint = {"do": "Два РАЗНЫХ прототипа (механизм и энергия, не только картинка), лист сравнения 390×844 + 1440, "
                  "владельцу одна картинка, ≤ 3 строки, один вопрос, своя рекомендация.",
            "tpl": TEMPLATES / "OWNER-MESSAGE.md",
            "cmd": tool_cmd("compare_sheet.py", f"--variant {a} --variant {b} --out {p.path('05-compare.png')}")}
    for x in (a, b):
        if not x.exists():
            pr.append(f"нет {rel(x, p.dir)}")
    if not pr:
        ta, tb = html_text(a), html_text(b)
        if min(len(ta), len(tb)) < 300:
            pr.append("прототип почти пустой (< 300 символов)")
        ratio = difflib.SequenceMatcher(None, ta, tb, autojunk=False).quick_ratio() if ta and tb else 1
        if ratio > 0.9 and difflib.SequenceMatcher(None, ta[:20000], tb[:20000]).ratio() > 0.8:
            pr.append("прототипы A и B почти одинаковы по коду (> 80 % совпадения): нужны разные механизмы")
    if not pr and sheet_ok(p, p.path("05-compare.png"), 2, "A и B рядом", pr):
        p.choice("5", pr, "какой прототип берём", allowed=r"^(A|B|А|Б|гибрид)")
    return pr, hint


def g6(p):
    pr = []
    src = source_files(p.root, p.f("Исходники"))
    if not src:
        pr.append(f"по «Исходники: {p.f('Исходники')}» не найдено ни одного файла кода страницы")
    if not meaningful(p.f("Адрес проверки")):
        pr.append("в STATUS.md нет «- Адрес проверки: <url, где открывается страница>»")
    c = p.choices.get("5") or {}
    if src and c.get("verified"):
        t5 = c.get("said_at")
        bad = code_before_choice(p, t5) if t5 else None
        if t5 is None:
            pr.append("время ответа владельца на ВЫБОР 5 неизвестно: нельзя проверить, что код написан после выбора")
        elif bad is None:
            pr.append(f"нет снимка кода страницы {BASELINE} (удалён или страница заведена без flow). Верни его из git "
                      f"(git restore {rel(p.dir / BASELINE, p.root)}). Из нынешнего кода он не пересоздаётся; "
                      "если файла нет и в git, решает человек")
        elif bad:
            pr.append(f"код появился до выбора владельца: откатите изменения и повторите после выбора (выбор "
                      f"{t5.astimezone():%d.%m %H:%M}). Файлы: {', '.join(bad[:5])} (git restore или удалить, "
                      "запустить flow, написать заново по выбранному прототипу)")
    return pr, {"do": "Собери выбранный вариант (только его). Текст только из источника владельца или по MESSAGE.md. "
                      "Запиши в STATUS.md адрес, где страница открывается.", "file": p.dir / "STATUS.md"}


def g7(p):
    pr = []
    art = p.path("artifacts")
    beginner = p.f("Новичок").lower() == "да"
    text_src = p.f("Текст владельца")
    src_arg = f" --source {p.root / text_src}" if text_src and not is_none(text_src) else ""
    cmd = tool_cmd("gate.py", f"--url {p.f('Адрес проверки')} --viewports 360,390,1440 --engine both "
                              f"--facts {p.path('FACTS.md')}{src_arg}{' --beginner' if beginner else ''} --out {art}")
    hint = {"do": "Гейт на 360/390/1440 в Chromium и WebKit, потом судья без кода: подагент (инструмент Agent, без "
                  "model:) по контакт-листам с templates/JUDGE-PROMPT.md, дефолт FAIL, 2 раунда. Его ответ дословно в "
                  "artifacts/judge/JUDGE.md; flow.py сверяет его с ответом подагента в переписке. Судью не отключать.",
            "cmd": cmd, "tpl": TEMPLATES / "JUDGE-PROMPT.md"}
    src = source_files(p.root, p.f("Исходники"))
    newest = newest_mtime(src)
    gp = art / "design-gate.json"
    if not gp.exists():
        return ["нет artifacts/design-gate.json (гейт не запускался)"], hint
    g = json.loads(gp.read_text(encoding="utf-8"))
    if gp.stat().st_mtime < newest:
        pr.append("гейт старше последней правки кода: перезапусти")
    if g.get("verdict") != C.PASS:
        if g.get("verdict") == C.CONCERNS and not pr:
            p.choice("7", pr, "владелец принял пункты «на глаза человеку» из гейта")
        else:
            pr.append(f"гейт: {g.get('verdict')}. Чинить пункты ПРОВАЛ и перезапускать")
    if (g.get("url") or "").rstrip("/") != p.f("Адрес проверки").rstrip("/"):
        pr.append(f"гейт снят с {g.get('url')}, а в STATUS.md адрес {p.f('Адрес проверки')}")
    parts = {x["part"]: x for x in g.get("parts", [])}
    vg = read(art / "visual-gate" / "report.json")
    if vg:
        v = json.loads(vg)
        miss = {360, 390, 1440} - set(v.get("viewports", []))
        if miss:
            pr.append(f"гейт без ширин {sorted(miss)}")
        if {"chromium", "webkit"} - set(v.get("engines", [])):
            pr.append("гейт не в обоих движках (Chromium и WebKit)")
    else:
        pr.append("нет artifacts/visual-gate/report.json")
    sl = read(art / "slop-lint" / "slop-lint.json")
    if not sl:
        pr.append("нет отчёта slop_lint")
    else:
        s = json.loads(sl)
        if not s.get("factsFile"):
            pr.append("slop_lint шёл без --facts FACTS.md: обещания-планы на странице не проверены")
        if beginner and not s.get("beginner"):
            pr.append("гость новичок, а slop_lint шёл без --beginner (жаргон не проверен)")
    if text_src and not is_none(text_src) and "text_diff" not in parts:
        pr.append("есть текст владельца, а сверки текста не было (gate.py --source)")
    if pr:
        return pr, hint
    j = p.path("artifacts/judge/JUDGE.md")
    if not j.exists():
        return ["нет отчёта судьи artifacts/judge/JUDGE.md"], hint
    jt = read(j)
    if j.stat().st_mtime < newest:
        pr.append("судья смотрел старую версию (код менялся после него): новый раунд")
    m = re.search(r"(?m)^\s*JUDGE-VERDICT\s*:\s*(\w+)", jt)
    if not m:
        pr.append("в отчёте судьи нет строки «JUDGE-VERDICT: PASS|FAIL» (нет строки = FAIL)")
    elif m.group(1).upper() != "PASS":
        pr.append(f"судья: {m.group(1)}. Исправь находки, подтверждённые кадром, и новый раунд")
    rd = re.search(r"(?m)^\s*РАУНД\s*:\s*(\d+)", jt)
    if not rd or int(rd.group(1)) < 2:
        pr.append("судья прошёл меньше 2 раундов («РАУНД: 2»)")
    rows, nc_lines = judge_lines(jt)
    open_bad = [r for r, _ in rows if re.match(r"\s*(blocker|critical)", r, re.I)]
    if open_bad:
        pr.append(f"у судьи открыто Blocker/Critical: {len(open_bad)}")
    no_where = [r for r, where in rows if not WHERE.search(where or "")]
    if no_where:
        pr.append(f"находки без селектора или региона в колонке «Где»: {len(no_where)} (например «{no_where[0][:60]}»)")
    nc = section(jt, r"не провер") or ""
    if not meaningful(nc):
        pr.append("в отчёте судьи пуст раздел «Что я НЕ проверил»")
    canon = [d for d in (p.root / "canon", p.dir / "canon") if d.is_dir() and count_images(d)]
    cm = re.search(r"(?m)^\s*КАНОН\s*:\s*(\d+)\s*/\s*10", jt)
    if canon and (not cm or int(cm.group(1)) < 8):
        pr.append("есть canon/: судья должен сравнить с каноном, «КАНОН: N/10», порог 8")
    if pr:
        return pr, hint
    # the report must be the judge subagent's own answer, line for line, not text the main agent wrote
    answers = p.owner.judge_answers()
    if answers is None:
        p.unverified.append("судья")
        return pr, hint
    after = dt.datetime.fromtimestamp(newest, dt.timezone.utc)
    mine = judge_signature(jt)
    same = [ts for ts, text in answers if judge_signature(text) == mine]
    if not same:
        sigs = [judge_signature(text) for ts, text in answers]
        if any(s[0] == mine[0] for s in sigs):
            pr.append("строки находок или «не проверила» в JUDGE.md не совпадают с ответом судьи-подагента целиком "
                      "(пропала, добавлена или изменена строка). Сохрани ответ дословно; менять можно только «Статус»")
        elif any(s[1:] == mine[1:] for s in sigs):
            names = ("JUDGE-VERDICT", "РАУНД", "КАНОН")
            diff = {names[i] for s in sigs if s[1:] == mine[1:] for i in range(3) if s[0][i] != mine[0][i]}
            pr.append(f"строки {', '.join(sorted(diff))} в JUDGE.md не такие, как в ответе судьи-подагента: "
                      "вердикт, раунд и оценку канона ставит судья, не ты")
        else:
            pr.append(f"нет ни в одном ответе судьи-подагента: засчитывается только вызов Agent, в промпте которого "
                      f"есть строка «{JUDGE_MARK}» и пути снимков, и его собственный ответ. Свой текст, Write, вывод "
                      "команды не годятся")
    elif not any(ts is not None and ts >= after for ts in same):
        pr.append("ответ судьи-подагента старше последней правки кода (или без времени): новый раунд по свежим снимкам")
    return pr, hint


def judge_signature(text):
    """What must be identical between JUDGE.md and the judge's answer: the head lines, every finding row (without
    «Статус») and every «не проверила» line, each compared whole."""
    head = []
    for rx in (r"(?m)^\s*JUDGE-VERDICT\s*:.*$", r"(?m)^\s*РАУНД\s*:.*$", r"(?m)^\s*КАНОН\s*:.*$"):
        m = re.search(rx, text or "")
        head.append(norm_words(m.group(0)) if m else "")
    rows, nc = judge_lines(text or "")
    return tuple(head), tuple(sorted(norm_words(r) for r, _ in rows)), tuple(sorted(norm_words(x) for x in nc))


WHERE = re.compile(r"[#.][A-Za-z_][\w-]*|\w\s*>\s*\w|\by\s*=\s*\d|\d+\s*[x×]\s*\d+|\b(header|main|footer|nav|section|"
                   r"button|h[1-6]|img|form|figure|ul|li|div|span|svg|canvas)\b", re.I)


def judge_lines(jt):
    """Finding rows of the judge table as text without the «Статус» column (the only column the main agent may
    edit), with their «Где» cell; and the bullet lines of «что я не проверила»."""
    rows = []
    for head, body in tables(jt):
        hl = [h.lower() for h in head]
        if not any("серь" in h for h in hl):
            continue
        skip = {i for i, h in enumerate(hl) if "статус" in h}
        wi = next((i for i, h in enumerate(hl) if "где" in h), None)
        for r in body:
            if not any(c.strip() for c in r):
                continue
            rows.append((" ".join(c for i, c in enumerate(r) if i not in skip),
                         r[wi] if wi is not None and wi < len(r) else ""))
    nc = section(jt, r"не провер") or ""
    return rows, re.findall(r"(?m)^\s*[-*]\s+(.+)$", nc)


def g8(p):
    pr = []
    rb = p.f("Откат")
    if not meaningful(rb):
        pr.append("в STATUS.md нет «- Откат: <как вернуть как было>»")
    elif LATER.search(rb) or not ROLLBACK.search(rb):
        pr.append(f"«Откат: {rb[:60]}» не конкретен: нужна команда или путь (ln -sfn releases/<прошлый> current, "
                  "git revert <коммит>, ПЕРЕМЕННАЯ=значение, путь к скрипту)")
    if not pr:
        p.choice("8", pr, "владелец сказал «да» на выкладку")
    return pr, {"do": "Выкладка только с «да» владельца: спроси одним сообщением со ссылкой и листом, рецепт и откат "
                      "в STATUS.md.", "tpl": TEMPLATES / "OWNER-MESSAGE.md"}


GATES = {"0": g0, "0a": g0a, "1": g1, "2": g2, "2a": g2a, "3": g3, "4": g4, "5": g5, "6": g6, "7": g7, "8": g8}


def evaluate(page, upto=None):
    """Run gates in order up to (not including) `upto`; stop at the first failing one."""
    done = []
    gates = ORDER if upto is None else ORDER[:ORDER.index(upto)]
    for gid in gates:
        pr, hint = GATES[gid](page)
        if pr:
            return done, (gid, pr, hint)
        done.append(gid)
    return done, None


def init_page(page_dir):
    d = Path(page_dir)
    d.mkdir(parents=True, exist_ok=True)
    made = []
    for src, dst in [("STATUS.md", "STATUS.md"), ("INTAKE.md", "00-intake.md"), ("TEARDOWN.md", "01-teardown.md"),
                     ("BRAND.md", "02-brand.md"), ("MESSAGE.md", "MESSAGE.md"), ("FACTS.md", "FACTS.md"),
                     ("REFERENCES.md", "03-references.md"), ("MOTION-CONTRACT.md", "04-motion.md")]:
        if not (d / dst).exists():
            shutil.copyfile(TEMPLATES / src, d / dst)
            made.append(dst)
    dec = d.resolve().parent / "DECISIONS.md"                     # design/DECISIONS.md for «- Решения: нет»
    if d.resolve().parent.name == "design" and not dec.exists():
        shutil.copyfile(TEMPLATES / "DECISIONS.md", dec)
        made.append("../DECISIONS.md")
    return made


SHEETS = re.compile(r"(0[125]-(compare|storyboard|directions|candidates)|02a-message|03-(references|refs|compare))\.png$", re.I)
MEANING_LINK = re.compile(r"/(MESSAGE|FACTS)\.md([?#]\S*)?$", re.I)   # step 2a: the meaning itself, not the built page
OPTION = re.compile(r"^\s*[-*]?\s*[А-ЯA-Z][.)]\s+\S")
MATERIALS = re.compile(r"^\s*[-*]?\s*(пришлите|пришлёте|пришлете|скиньте|отправьте|если есть)\b", re.I)


def lint_message(path, page=None, transcripts=None):
    """Two kinds of owner message.
    Questions (step 0a, no image): at most 3 questions, each with 2–4 lettered options, a recommendation per question.
    Showing (an image or a link): exactly one image or link, at most 3 lines of text, one question, a recommendation.
    Showing the built page (a link, or an image that is not a choice sheet) needs gates 0–7 passed (--page).
    Step 2a shows the meaning: 02a-message.png or a link to MESSAGE.md / FACTS.md is a sheet, not the page."""
    t = read(path)
    if t is None:
        return [f"нет файла {path}"]
    import slop_lint as SL
    pr = []
    lines = [ln for ln in t.splitlines() if ln.strip()]
    imgs = [ln for ln in lines if SHOT_RE.search(ln)]
    opts = [ln for ln in lines if OPTION.match(ln)]
    links = [ln for ln in lines if re.search(r"https?://", ln) and ln not in imgs and ln not in opts]  # mood examples
    asks = [ln for ln in lines if MATERIALS.match(ln)]           # «пришлите, что есть: логотип, фото...»: not a question
    q = sum(ln.count("?") for ln in lines if ln not in asks)
    recs = t.lower().count("рекомендую")
    if not imgs and not links and opts:                          # questions with options, step 0a
        if len(asks) > 1:
            pr.append(f"просьб прислать материалы {len(asks)}, нужна одна строка")
        if not 1 <= q <= 3:
            pr.append(f"вопросов {q}, нужно от одного до трёх")
        if len(opts) < 2 * max(q, 1):
            pr.append(f"вариантов {len(opts)}: у каждого вопроса нужно 2–4 варианта буквами")
        if recs < max(q, 1):
            pr.append(f"рекомендаций {recs}, нужна своя у каждого вопроса («(рекомендую)»)")
    else:                                                        # showing a sheet, a picture or the page
        shown = imgs + links
        text = [ln for ln in lines if ln not in shown]
        if len(shown) != 1:
            pr.append(f"картинок и ссылок {len(shown)}, нужна ровно одна (лист или страница)")
        if len(text) > 3:
            pr.append(f"строк текста {len(text)}, не больше 3")
        if q != 1:
            pr.append(f"вопросов {q}, нужен ровно один")
        if not recs:
            pr.append("нет своей рекомендации («Рекомендую ...»)")
        page_shown = ([ln for ln in links
                       if not all(MEANING_LINK.search(u.rstrip(".,;:)»")) for u in re.findall(r"https?://\S+", ln))] +
                      [ln for ln in imgs if not SHEETS.search(ln.strip().split()[-1])])
        if page_shown:
            if not page:
                pr.append("показ готовой страницы: укажи --page design/<page>, сначала проверим ворота 0–7")
            else:
                pg = Page(page, transcripts)
                done, fail = evaluate(pg, "8")
                if fail:
                    pr.append(f"показ готовой страницы до проверок: не пройдены ворота {fail[0]} «{TITLES[fail[0]]}» "
                              f"({fail[1][0]})")
                elif pg.unverified:
                    pr.append("показ готовой страницы: выборы владельца или судья не сверены с перепиской "
                              f"({', '.join(pg.unverified)})")
    if SL.bad_dash(t):
        pr.append("длинное тире в тексте для человека")
    return pr


def main():
    C.setup_io()
    ap = argparse.ArgumentParser(description="Ворота процесса вау-страницы: один следующий шаг. "
                                 "Выход 0 готово / 1 есть невыполненные ворота / 2 цитаты владельца не сверены.")
    ap.add_argument("--page", help="папка страницы, например design/about")
    ap.add_argument("--stage", choices=ORDER, help="хочу начать этот шаг: проверить все ворота до него")
    ap.add_argument("--init", action="store_true", help="завести папку страницы из шаблонов")
    ap.add_argument("--transcripts", help="папка с переписками *.jsonl (по умолчанию ~/.claude/projects/<проект>)")
    ap.add_argument("--lint-message", help="проверить файл сообщения владельцу")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()

    if a.lint_message:
        pr = lint_message(a.lint_message, a.page, a.transcripts)
        print("сообщение владельцу: " + ("ок" if not pr else "НЕ ОТПРАВЛЯТЬ"))
        for x in pr:
            print("  - " + x)
        return 0 if not pr else 1
    if not a.page:
        ap.error("нужен --page design/<page>")
    if a.init:
        made = init_page(a.page)
        Page(a.page, a.transcripts)                  # snapshot of the page code before any work: .flow-baseline.json
        print(f"flow: папка {a.page} заведена, из шаблонов: {', '.join(made) or 'всё уже было'}")
        print(f"дальше: заполни STATUS.md и запусти  {tool_cmd('flow.py', '--page ' + a.page)}")
        return 0
    if a.transcripts and not any(Path(a.transcripts).glob("*.jsonl")):
        print(f"flow: в {a.transcripts} нет переписок *.jsonl. Пустую папку подставлять нельзя.")
        return 1
    p = Page(a.page, a.transcripts)
    done, fail = evaluate(p, a.stage)
    res = {"page": str(p.dir), "projectRoot": str(p.root), "stage": a.stage, "done": done,
           "transcripts": [str(d) for d in p.owner.dirs] if p.owner.available else [],
           "unverifiedOwnerQuotes": p.unverified}
    if fail:
        gid, pr, hint = fail
        res["next"] = {"gate": gid, "title": TITLES[gid], "problems": pr,
                       **{k: str(v) for k, v in hint.items()}}
    code = 1 if fail else (2 if p.unverified else 0)
    res["exit"] = code
    if a.json:
        print(json.dumps(res, ensure_ascii=False, indent=1))
        return code
    print(f"flow: {rel(p.dir, p.root)}  (проект {p.root})")
    for gid in done:
        print(f"  ок   {gid:<3} {TITLES[gid]}")
    if fail:
        gid, pr, hint = fail
        if a.stage:
            print(f"\nНЕЛЬЗЯ начинать шаг {a.stage}: не пройдены ворота {gid}.")
        print(f"\nСЛЕДУЮЩИЙ ШАГ: {gid} {TITLES[gid]}")
        print(f"  Что сделать: {hint['do']}")
        for k, lbl in (("tpl", "Шаблон"), ("tpl2", "Шаблон"), ("file", "Файл"), ("cmd", "Команда")):
            if k in hint:
                print(f"  {lbl}: {hint[k]}")
        print("  Не хватает:")
        for x in pr[:12]:
            print(f"    - {x}")
        print(f"  После шага снова: {tool_cmd('flow.py', '--page ' + str(a.page))}")
    elif a.stage:
        print(f"\nМожно начинать шаг {a.stage}: {TITLES[a.stage]}.")
    else:
        print("\nВсе ворота пройдены.")
    if p.unverified:
        where = ", ".join(str(d) for d in p.owner.dirs) or "не найдено"
        print(f"\nВНИМАНИЕ: цитаты владельца ({', '.join(p.unverified)}) не сверены: переписки нет ({where}). "
              "Сессия запущена не из папки проекта? Покажи строки ВЫБОР человеку.")
    return code


if __name__ == "__main__":
    sys.exit(main())
