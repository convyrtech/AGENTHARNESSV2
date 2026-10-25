"""A/B судьи: прежний (свободный разбор) против нового (вопросы «да/нет», вердикт кодом) на записанных страницах.

На копии страницы (оригинал не трогается) судья проходит раунды 1..--max-rounds подряд, пока не скажет PASS. Код между
раундами никто не правит, поэтому замер показывает именно сходимость: держит ли судья своё слово по той же странице
(в E9 находки росли 2 → 7 → 14). flow.py требует ≥ 2 раундов, так что лучший возможный итог — PASS на 2-м.

  judge_ab.py --page /home/user/ab/run/сайт/design/landing --page /home/user/ab/base/сайт/design/landing
              [--pipeline <design-pipeline>] [--proxy http://127.0.0.1:8787] [--model claude-opus-5-5]
              [--max-rounds 3] [--out judge-ab.json]
Печатает таблицу; сырые ответы каждого раунда — в <out>.d/<страница>/<режим>/. Деньги — поле cost ответа шлюза, если
он его отдаёт; итог по журналу a6 — abreport.py cost.
"""
import argparse, json, shutil, subprocess, sys, tempfile, time
from pathlib import Path

ap = argparse.ArgumentParser()
ap.add_argument("--page", action="append", required=True, help="папка страницы <ws>/design/<page>; можно несколько")
ap.add_argument("--pipeline", help="design-pipeline (по умолчанию <ws>/design-pipeline у каждой страницы)")
ap.add_argument("--proxy", default="http://127.0.0.1:8787")
ap.add_argument("--model", default="claude-opus-5-5")
ap.add_argument("--max-rounds", type=int, default=3)
ap.add_argument("--out", default="judge-ab.json")
a = ap.parse_args()
JUDGE = Path(__file__).resolve().parent / "judge.py"
out_dir = Path(a.out + ".d")


def label(page):
    """«run/landing» и «base/landing»: у обоих записей рабочая папка зовётся одинаково («сайт»)."""
    p = Path(page).resolve()
    return f"{p.parents[2].name}/{p.name}" if len(p.parents) > 2 else p.name


def run_mode(page, mode):
    page = Path(page).resolve()
    root = page.parent.parent if page.parent.name == "design" else page.parent
    pipe = Path(a.pipeline).resolve() if a.pipeline else root / "design-pipeline"
    tmp = Path(tempfile.mkdtemp(prefix=f"judge-ab-{mode}-"))
    try:
        copy = tmp / "design" / page.name
        # copy2 сохраняет время файлов: контакт-листы остаются новее кода, как в записи
        shutil.copytree(page, copy, copy_function=shutil.copy2, ignore=shutil.ignore_patterns("judge"))
        rounds = []
        for _ in range(a.max_rounds):
            t0 = time.time()
            r = subprocess.run([sys.executable, "-I", str(JUDGE), "--page", str(copy), "--transcripts", str(tmp / "state"),
                                "--pipeline", str(pipe), "--proxy", a.proxy, "--model", a.model,
                                "--max-rounds", str(a.max_rounds), "--questions", mode],
                               capture_output=True, text=True, encoding="utf-8")
            line = (r.stdout.strip().splitlines() or [""])[-1]
            try:
                info = json.loads(line)
            except ValueError:
                info = {"error": (r.stdout + r.stderr).strip()[-300:], "exit": r.returncode}
            info["wall_seconds"] = round(time.time() - t0)
            rounds.append(info)
            raw = copy / "artifacts" / "judge" / f"ROUND-{len(rounds)}.md"
            dest = out_dir / label(page).replace("/", "-") / mode
            dest.mkdir(parents=True, exist_ok=True)
            if raw.exists():
                shutil.copy2(raw, dest / raw.name)
            if r.returncode != 0 or (info.get("verdict") or "").upper() == "PASS":
                break
        return rounds
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def summary(rounds):
    passed = next((i + 1 for i, r in enumerate(rounds) if (r.get("verdict") or "").upper() == "PASS"), None)
    found = [sum((r.get("findings") or {}).values()) for r in rounds]
    cost = [r.get("cost") for r in rounds]
    return {"pass_round": passed, "findings_by_round": found,
            "seconds": sum(r.get("seconds") or r.get("wall_seconds") or 0 for r in rounds),
            "prompt_tokens": sum(r.get("prompt_tokens") or 0 for r in rounds),
            "completion_tokens": sum(r.get("completion_tokens") or 0 for r in rounds),
            "cost": round(sum(c for c in cost if c), 4) if any(cost) else None,
            "yes_by_round": [r.get("yes") for r in rounds], "errors": [r["error"] for r in rounds if "error" in r]}


report = {}
for page in a.page:
    report[page] = {mode: {"rounds": (rr := run_mode(page, mode)), "summary": summary(rr)} for mode in ("off", "on")}
Path(a.out).write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
print("| Страница | Судья | PASS на раунде | Находки по раундам | «да» по раундам | Время, с | Токены вх/вых | $ |")
print("|---|---|---|---|---|---|---|---|")
for page, modes in report.items():
    for mode, name in (("off", "прежний"), ("on", "да/нет")):
        s = modes[mode]["summary"]
        print(f"| {label(page)} | {name} | {s['pass_round'] or '—'} | "
              f"{' → '.join(map(str, s['findings_by_round'])) or '—'} | "
              f"{' → '.join('—' if y is None else str(y) for y in s['yes_by_round'])} | {s['seconds']} | "
              f"{s['prompt_tokens']}/{s['completion_tokens']} | {'—' if s['cost'] is None else s['cost']} |")
        for e in s["errors"]:
            print(f"|  | ошибка | {e[:120]} |  |  |  |  |  |")
print(f"\nСырые ответы: {out_dir}/, сводка: {a.out}")
