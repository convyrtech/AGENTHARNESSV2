"""База A набора «Исследовать» (research/26 §4.10, R0/R1): сильная модель в Pi только с web_search и web_fetch.

  python3 run_pi.py --model a6/claude-opus-5-5 --search search.json --out runs/a-opus.jsonl [--only r01,i05]
                    [--base https://a6api.com/v1] [--key-file ../.a6key] [--pi "node <pi>/dist/bundle/cli.js"]

search.json — поставщик поиска для web_search: {"provider": "free"} (бесплатный, без ключа), {"provider": "deepseek",
"key": "…"}, {"provider": "searxng", "url": "https://…"}, {"provider": "prsloy", "url": "https://шлюз/v1", "key":
"ключ шлюза"} и т. п. (поля — как в настройках приложения). Ключ модели читается из файла и кладётся во временную папку агента (права 600), после прогона
папка удаляется. Ответ — results.jsonl для score.py: ответ, источники с дословными цитатами, запросы, цена, время.
"""
import argparse, datetime as dt, json, os, re, shutil, subprocess, sys, tempfile, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
SYSTEM = """Сегодня {today}. Ты отвечаешь на вопрос, пользуясь поиском в интернете (web_search) и чтением страниц
(web_fetch). Ищи свежие первоисточники: официальные сайты, документацию, законы, репозитории. Числа и даты бери только
из прочитанных страниц. Отвечай по-русски, коротко.

В конце — строго такой блок, по строке на источник, цитата дословно из текста страницы:
ИСТОЧНИКИ:
[n] URL — «дословная цитата»"""
SOURCE = re.compile(r"^\s*\[(\d+)\]\s+(https?://\S+?)\s+[—–-]\s+[«\"](.+?)[»\"]\s*$")


def find_pi():
    found = sorted((REPO / "app" / "node_modules" / ".pnpm").glob(
        "@earendil-works+pi-coding-agent@*/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"))
    return ["node", str(found[-1])] if found else ["pi"]


def agent_dir(base, key, model):
    """Временная папка агента: один поставщик моделей, ключ — только здесь."""
    d = Path(tempfile.mkdtemp(prefix="bench-agent-"))
    provider, _, mid = model.partition("/")
    models = {"providers": {provider: {"name": provider, "baseUrl": base, "api": "openai-completions", "apiKey": key,
                                       "models": [{"id": mid, "name": mid, "reasoning": False, "input": ["text"],
                                                   "contextWindow": 200000, "maxTokens": 16000,
                                                   "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}}]}}}
    f = d / "models.json"
    f.write_text(json.dumps(models), encoding="utf-8")
    os.chmod(f, 0o600)
    return d


def parse(final):
    """Ответ без блока источников и источники [n] URL — «цитата»."""
    head, _, tail = final.partition("ИСТОЧНИКИ:")
    sources = []
    for ln in tail.splitlines():
        m = SOURCE.match(ln)
        if m:
            sources.append({"n": int(m.group(1)), "url": m.group(2).rstrip(".,;"), "quote": m.group(3)})
    return head.strip(), sources


def run_one(a, adir, q, today, out_dir):
    sys_file = out_dir / "system.md"
    sys_file.write_text(SYSTEM.format(today=today), encoding="utf-8")
    env = {**os.environ, "PI_CODING_AGENT_DIR": str(adir), "BENCH_RESEARCH_CONFIG": str(Path(a.search).resolve()),
           "BENCH_RESEARCH_OUT": str(out_dir / q["id"])}
    args = [*a.pi, "--mode", "json", "--model", a.model, "--no-session", "--no-builtin-tools", "--no-context-files",
            "--no-skills", "-e", str(HERE / "bench_ext.ts"), "--append-system-prompt", str(sys_file), q["q"]]
    t0 = time.time()
    try:
        r = subprocess.run(args, env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True, encoding="utf-8",
                           errors="replace", timeout=a.timeout)
        out, err = r.stdout, (r.stderr if r.returncode else "")
    except subprocess.TimeoutExpired as e:
        out = e.stdout if isinstance(e.stdout, str) else (e.stdout or b"").decode("utf-8", "replace")
        err = f"время вышло ({a.timeout} с)"
    final, queries, cost, calls = "", [], 0.0, 0
    for ln in out.splitlines():
        try:
            e = json.loads(ln)
        except ValueError:
            continue
        m = e.get("message") or {}
        if e.get("type") == "message_end" and m.get("role") == "assistant":
            cost += ((m.get("usage") or {}).get("cost") or {}).get("total", 0) or 0
            for b in m.get("content") or []:
                if b.get("type") == "text" and b.get("text"):
                    final = b["text"]
                if b.get("type") == "toolCall":
                    calls += 1
                    if b.get("name") == "web_search":
                        queries.append(str((b.get("arguments") or {}).get("query", "")))
    answer, sources = parse(final)
    # дата источника — из журнала инструментов этого вопроса, если страницу читали
    ledger = out_dir / q["id"] / "research"
    dates = {}
    for f in ledger.glob("*/ledger.json"):
        for s in json.loads(f.read_text(encoding="utf-8")):
            if s.get("date"):
                dates[s["url"]] = s["date"]
    for s in sources:
        if s["url"] in dates:
            s["date"] = dates[s["url"]]
    return {"id": q["id"], "model": a.model, "answer": answer, "sources": sources, "queries": queries,
            "tool_calls": calls, "cost_usd": round(cost, 6) or None, "seconds": round(time.time() - t0, 1),
            "error": err[-300:] or None}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True, help="поставщик/модель, например a6/claude-opus-5-5")
    ap.add_argument("--search", required=True, help="файл с поставщиком поиска (JSON)")
    ap.add_argument("--out", required=True)
    ap.add_argument("--only")
    ap.add_argument("--base", default="https://a6api.com/v1")
    ap.add_argument("--key-file", default=str(HERE.parent / ".a6key"))
    ap.add_argument("--pi", type=lambda s: s.split(), default=None)
    ap.add_argument("--timeout", type=int, default=300)
    a = ap.parse_args()
    a.pi = a.pi or find_pi()
    qs = json.loads((HERE / "questions.json").read_text(encoding="utf-8"))["questions"]
    only = set(a.only.split(",")) if a.only else None
    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    done = {json.loads(x)["id"] for x in out.read_text(encoding="utf-8").splitlines() if x.strip()} if out.exists() else set()
    adir = agent_dir(a.base, Path(a.key_file).read_text(encoding="utf-8").strip(), a.model)
    work = out.with_suffix("")
    work.mkdir(parents=True, exist_ok=True)
    today = dt.date.today().isoformat()
    try:
        with open(out, "a", encoding="utf-8") as f:
            for q in qs:
                if (only and q["id"] not in only) or q["id"] in done:
                    continue
                r = run_one(a, adir, q, today, work)
                f.write(json.dumps(r, ensure_ascii=False) + "\n")
                f.flush()
                print(q["id"], "ошибка: " + r["error"] if r["error"] else
                      f"{r['seconds']} с, вызовов {r['tool_calls']}, источников {len(r['sources'])}")
    finally:
        shutil.rmtree(adir, ignore_errors=True)


if __name__ == "__main__":
    main()
