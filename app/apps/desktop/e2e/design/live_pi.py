"""A pi stand-in that does real work: for the «Дизайн» live e2e (design-live.spec.ts) and design-windows.

Like pi --mode json it prints one `message_end` per assistant step: the tool call goes out before the tool runs, so
the tab shows it while it works. Bash calls run through the agent's shell, as pi does: `shellPath` from
$PI_CODING_AGENT_DIR/settings.json (Git Bash on Windows), so `python3` resolves to the app's shims, then the real
harness tools run on the venv (moves.py with Edge, check.py, flow.py).

The step comes from the harness brief («Шаг 1 «…»»), against the stub pipeline's steps:
  0  fill the passport → ЭТАП ГОТОВ
  1  words → moves.py candidates (sheet + three mp4) → ВЛАДЕЛЬЦУ with the sheet and videos;
     after the owner's answer: «ВЫБОР 1» in his words → moves.py pick → ЭТАП ГОТОВ
  2  04-motion.md + site/landing/index.html → check.py → ЭТАП ГОТОВ
$PI_CODING_AGENT_DIR/live-control.json:
  {"crash": n}  the next n runs die after their first tool call (exit 3, no text);
  {"hold": s}   once, step 1 first runs a tool that opens the tools' browser and holds it s seconds (a turn to close
                the app in the middle of: bash → python → Edge/Chromium, like moves.py)
"""
import datetime as dt, json, os, re, subprocess, sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")
HOME = Path(os.environ["PI_CODING_AGENT_DIR"])
WS = Path.cwd()
PAGE = WS / "design" / "landing"
STATE = HOME / "live-state.json"


def shell():
    try:
        sp = json.loads((HOME / "settings.json").read_text(encoding="utf-8")).get("shellPath")
    except (OSError, ValueError):
        sp = None
    if sp:
        return sp
    git_bash = Path(os.environ.get("ProgramFiles", r"C:\Program Files")) / "Git" / "bin" / "bash.exe"
    return str(git_bash) if os.name == "nt" and git_bash.exists() else "bash"


def say(content, final=False):
    msg = {"role": "assistant", "content": content,
           "usage": {"input": 4200, "output": 380, "cacheRead": 3100, "cost": {"total": 0.0021}}}
    print(json.dumps({"type": "message_end", "message": msg}, ensure_ascii=False), flush=True)
    if final:
        print(json.dumps({"type": "agent_end"}), flush=True)


def tool(name, args):
    say([{"type": "toolCall", "id": f"c{os.getpid()}", "name": name, "arguments": args}])
    if crash_now():
        sys.exit(3)


def bash(cmd):
    tool("bash", {"command": cmd})
    r = subprocess.run([shell(), "-c", cmd], cwd=WS, capture_output=True)
    out = (r.stdout + r.stderr).decode("utf-8", "replace")
    if r.returncode:
        finish(f"команда упала ({r.returncode}): {cmd}\n{out[-600:]}")
    return out


def write(rel, text):
    tool("write", {"path": rel, "content": text[:60] + "…"})
    p = WS / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding="utf-8")


def finish(text):
    say([{"type": "text", "text": text}], final=True)
    sys.exit(0)


_crash = None


def crash_now():
    """Once per run: does live-control.json say this run dies?"""
    global _crash
    if _crash is None:
        ctl = HOME / "live-control.json"
        data = json.loads(ctl.read_text(encoding="utf-8")) if ctl.exists() else {}
        _crash = data.get("crash", 0) > 0
        if _crash:
            data["crash"] -= 1
            ctl.write_text(json.dumps(data), encoding="utf-8")
    return _crash


HOLD = ("import os, time; from playwright.sync_api import sync_playwright\n"
        "with sync_playwright() as p:\n"
        "    ch = os.environ.get('DP_BROWSER_CHANNEL')\n"
        "    b = p.chromium.launch(**({'channel': ch} if ch else {}))\n"
        "    b.new_page().goto('about:blank'); time.sleep({secs})\n")


def take_hold():
    ctl = HOME / "live-control.json"
    data = json.loads(ctl.read_text(encoding="utf-8")) if ctl.exists() else {}
    secs = data.pop("hold", 0)
    if secs:
        ctl.write_text(json.dumps(data), encoding="utf-8")
    return secs


def owner_said():
    lines = (WS / "owner" / "messages.jsonl").read_text(encoding="utf-8").splitlines()
    return [json.loads(x) for x in lines if x.strip()]


def main():
    args = sys.argv[1:]
    brief = Path(next(x for x in args if x.startswith("@"))[1:]).read_text(encoding="utf-8")
    m = re.search(r"Шаг (\S+) «", brief)
    gate = m.group(1) if m else "?"
    state = json.loads(STATE.read_text(encoding="utf-8")) if STATE.exists() else {}
    status = PAGE / "STATUS.md"

    if gate == "0":
        text = status.read_text(encoding="utf-8").replace("- Владелец: ...", "- Владелец: кофейня «Зерно»")
        write("design/landing/STATUS.md", text)
        bash("python3 -I design-pipeline/tools/flow.py --page design/landing")
        finish("Паспорт заполнен.\nЭТАП ГОТОВ")

    if gate == "1":
        asked = state.get("asked1", 0)
        msgs = owner_said()
        if asked and len(msgs) > asked:                 # the owner answered the sheet
            words = msgs[-1]["text"]
            pack = {"А": "A", "Б": "B", "В": "C"}.get(words.strip()[:1].upper(), words.strip()[:1].upper())
            today = dt.date.today().isoformat()
            write("design/landing/STATUS.md", status.read_text(encoding="utf-8").rstrip("\n") +
                  f"\n- ВЫБОР 1: {pack} · «{words}» · {today}\n")
            bash(f"python3 -I harness/moves.py pick --page design/landing --pack {pack}")
            bash("python3 -I design-pipeline/tools/flow.py --page design/landing")
            finish(f"Набор {pack} разобран.\nЭТАП ГОТОВ")
        secs = take_hold()
        if secs:
            hold = WS / "harness" / "browser_hold.py"
            hold.write_text(HOLD.replace("{secs}", str(secs)), encoding="utf-8")
            bash("python3 -I harness/browser_hold.py")
        write("design/landing/01-cands/words.json", json.dumps(
            {"num": "180 ₽", "step1": "Закажите", "step2": "Мы обжарим", "step3": "Заберите",
             "limitLabel": "чашек за утро", "limit": "1 240", "stamp": "ГОТОВО", "sloganRise": "с утра"},
            ensure_ascii=False))
        # the agent's shell finds the app's python3 shim (not the Microsoft Store stub) and a full stdlib
        probe = bash('python3 -c "import threading, sqlite3, ssl, sys; print(1, sys.executable)"')
        (HOME / "live-probe.txt").write_text(probe, encoding="utf-8")
        bash("python3 -I harness/moves.py candidates --page design/landing")
        state["asked1"] = len(msgs)
        STATE.write_text(json.dumps(state), encoding="utf-8")
        finish("ВЛАДЕЛЬЦУ:\nТри варианта движения в ваших цветах: design/landing/01-candidates.png\n"
               "Видео: design/landing/01-cands/A.mp4 design/landing/01-cands/B.mp4 design/landing/01-cands/C.mp4\n"
               "A. Кольцо и счётчик (рекомендую)\nB. Выдача с печатью\nC. Тропа к кнопке")

    if gate == "2":
        write("design/landing/04-motion.md", "# Движение\n\n## Фирменный приём\nКадр f05 набора A → кольцо вокруг цены.\n")
        write("site/landing/index.html", (
            "<!doctype html><html lang=ru><meta charset=utf-8><title>Зерно</title>"
            "<body style='margin:0;font:18px/1.5 Georgia,serif;background:#f4ede1;color:#2b211b'>"
            "<main style='padding:64px 48px'><p style='letter-spacing:.2em;color:#b4532a'>КОФЕЙНЯ</p>"
            "<h1 style='font-size:64px;margin:.2em 0'>Зерно</h1>"
            "<p data-signature='ring' style='display:inline-block;border:2px solid #b4532a;border-radius:50%;"
            "padding:18px 28px'>180 ₽</p></main>"))
        bash("python3 -I harness/check.py site design/landing")
        bash("python3 -I design-pipeline/tools/flow.py --page design/landing")
        finish("Страница собрана, проверка харнесса прошла.\nЭТАП ГОТОВ")

    finish(f"не знаю шаг {gate}")


if __name__ == "__main__":
    main()
