"""Владелец по сценарию для чистого A/B харнесса: водит run.py (дирижёр) или baseline.py (одна сессия) одними и теми же
ответами.

После каждого вопроса владельцу (событие `owner`) смотрит, на каком шаге стоит страница (`flow.py --json`), и отвечает
из сценария: owner-e8p.json по умолчанию. Шаг 5, пока не выбрана раскадровка, — ключ «5s»; сообщение харнесса после
лимита судьи — «7j». Ответ null — остановиться (шаг 8). Без вопроса ход кончился лимитом шагов — шлёт пустое
сообщение («продолжай»); `stuck` — «Попробовать ещё раз» (--retry), не больше --retries раз подряд.

  simulate.py --driver run|baseline --ws <папка> --record <папка записи> --pipeline <design-pipeline>
              [--page landing] [--script owner-e8p.json] [--first "…"] [--materials <папка>]
              [--materials-with first|ask] [--max-turns 40] [--retries 1] [--model …]
              [--key-file <файл ключа a6>] [--a6-url https://a6api.com] [--parallel5 on|off]

--parallel5 — плечо A/B шага 5 (#21): HARNESS_PARALLEL5=1|0 для run.py, пишется в run.json; без него — как в
stages.json.

Запись прогона (её читает abreport.py) — вне папки агента:
  <record>/run.json        драйвер, модель, начало и конец, где остановился и почему
  <record>/turns.jsonl     ход: что отправлено, ключ сценария, окно времени [t0, t1], чем кончился, вопрос владельцу
  <record>/events/NN.jsonl события драйвера дословно
  <record>/state/          HARNESS_STATE_DIR: журнал, сессии, переписка судьи
С --key-file сразу после прогона забирает журнал a6 (`abreport.py cost`): он хранит только последние 1000 строк.
"""
import argparse, importlib.util, json, os, subprocess, sys, time
from pathlib import Path
for _s in (sys.stdout, sys.stderr):  # Windows: под -I PYTHONUTF8 не действует, а вывод в трубу идёт в cp1252
    _s.reconfigure(encoding="utf-8", errors="replace")

HERE = Path(__file__).resolve().parent
DRIVERS = {"run": HERE / "run.py", "baseline": HERE / "baseline.py"}


def load_script(path):
    sc = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(sc.get("answers"), dict):
        raise ValueError(f"{path}: нужен объект answers")
    return sc


def answer_key(fl, state):
    """Ключ сценария по состоянию страницы после вопроса владельцу."""
    if state.get("judge_cap_asked"):
        return "7j"
    nx = fl.get("next") or {}
    gate = str(nx.get("gate", "?"))
    if gate == "5" and any("раскадров" in p for p in nx.get("problems", [])):
        return "5s"
    return gate


def pick(script, key):
    """(текст или None — стоп, по сценарию ли ответ)."""
    ans = script["answers"]
    if key in ans:
        return ans[key], True
    if "*" in ans:
        return ans["*"], False
    return None, False


class Sim:
    def __init__(self, a):
        self.a = a
        self.ws = Path(a.ws).resolve()
        self.rec = Path(a.record).resolve()
        self.state_dir = self.rec / "state"
        for d in (self.rec / "events", self.state_dir):
            d.mkdir(parents=True, exist_ok=True)
        # состояние харнесса — в записи прогона, не рядом с папкой агента; драйвер получает его через окружение
        self.env = {**os.environ, "HARNESS_STATE_DIR": str(self.state_dir), "PYTHONUTF8": "1"}
        if a.parallel5:
            self.env["HARNESS_PARALLEL5"] = "1" if a.parallel5 == "on" else "0"
        os.environ["HARNESS_STATE_DIR"] = str(self.state_dir)
        self.driver = DRIVERS[a.driver]
        self.script = load_script(a.script)
        self.turns = []
        self.run = {"driver": a.driver, "ws": str(self.ws), "page": a.page, "script": str(Path(a.script).resolve()),
                    "model": a.model or ("a6p/kimi-k3.1-pro" if a.driver == "baseline" else "stages.json ladder"),
                    **({"parallel5": a.parallel5 == "on"} if a.parallel5 else {}),
                    "started": time.time()}

    # ---------- driver ----------
    def call(self, *args):
        return subprocess.run([sys.executable, "-I", str(self.driver), *args], env=self.env, capture_output=True,
                              text=True, encoding="utf-8")

    def init(self):
        if (self.state_dir / "state.json").exists():
            return
        args = ["init", str(self.ws), "--page", self.a.page, "--pipeline", self.a.pipeline]
        if self.a.driver == "baseline" and self.a.model:
            args += ["--model", self.a.model]
        r = self.call(*args)
        if r.returncode:
            sys.exit(f"simulate: init не получился: {r.stdout[-400:]}{r.stderr[-400:]}")

    def say(self, text, files=(), retry=False):
        n = len(self.turns) + 1
        args = ["say", str(self.ws), text]
        if files:
            args += ["--files", *files]
        if retry:
            args.append("--retry")
        t0 = time.time()
        log = self.rec / "events" / f"{n:02d}.jsonl"
        last, owner, tools = None, None, 0
        with open(log, "w", encoding="utf-8") as out:
            p = subprocess.Popen([sys.executable, "-I", str(self.driver), *args], env=self.env, stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace")
            for ln in p.stdout:
                out.write(ln)
                try:
                    ev = json.loads(ln)
                except ValueError:
                    continue
                if ev.get("ev") == "tool":
                    tools += 1
                if ev.get("ev") in ("owner", "done", "stuck", "note"):
                    last = ev
                if ev.get("ev") == "owner":
                    owner = ev
            err = p.stderr.read()
            p.wait()
        end = (last or {}).get("ev") or ("crash" if p.returncode else "none")
        turn = {"n": n, "sent": text, "files": [Path(f).name for f in files], "retry": retry, "t0": round(t0, 1),
                "t1": round(time.time(), 1), "end": end, "tools": tools, "exit": p.returncode}
        if owner:
            turn["question"] = owner.get("text", "")[:2000]
        if end == "crash":
            turn["stderr"] = err[-1500:]
        return turn

    def where(self):
        """flow.py --json и state.json драйвера (через run.py: то же окружение, что видит харнесс)."""
        if not hasattr(self, "_R"):
            spec = importlib.util.spec_from_file_location("harness_run", HERE / "run.py")
            self._R = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(self._R)
        R = self._R
        ws = R.WS(self.ws)
        return R.flow(ws, "--json"), ws.state

    def record(self, turn):
        self.turns.append(turn)
        with open(self.rec / "turns.jsonl", "a", encoding="utf-8") as f:
            f.write(json.dumps(turn, ensure_ascii=False) + "\n")
        print(f"ход {turn['n']:2}  {turn.get('key', ''):>3}  → «{turn['sent'][:50]}»  ⇒ {turn['end']}"
              f"  {turn['t1'] - turn['t0']:.0f} с", flush=True)

    def finish(self, why):
        fl, _ = self.where()
        self.run.update(finished=time.time(), stop=why, done=fl.get("exit") == 0,
                        reached_gate="done" if fl.get("exit") == 0 else (fl.get("next") or {}).get("gate"),
                        turns=len(self.turns), owner_messages=sum(1 for t in self.turns if t["sent"]))
        (self.rec / "run.json").write_text(json.dumps(self.run, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"стоп: {why}; шаг {self.run['reached_gate']}", flush=True)
        if self.a.key_file:
            r = subprocess.run([sys.executable, "-I", str(HERE / "abreport.py"), "cost", "--record", str(self.rec),
                                "--key-file", self.a.key_file, "--a6-url", self.a.a6_url], capture_output=True,
                               text=True, encoding="utf-8")
            print(r.stdout.strip() or r.stderr.strip()[-400:], flush=True)
        return self.run

    # ---------- the owner ----------
    def go(self):
        self.init()
        sc, a = self.script, self.a
        mats = sorted(str(p) for p in Path(a.materials).iterdir() if p.is_file()) if a.materials else []
        first = a.first or sc.get("first", "")
        mat_text = sc.get("materials_text", "")
        pending_mats = []
        if a.materials_with == "first" and mats:
            first, files = (first + "\n" + mat_text).strip(), mats
        else:
            files, pending_mats = [], mats
        text, retries = first, 0
        turn = self.say(text, files)
        while True:
            turn["key"] = ""
            if turn["end"] == "owner":
                fl, state = self.where()
                key = answer_key(fl, state)
                turn["key"] = key
                self.record(turn)
                ans, scripted = pick(sc, key)
                if ans is None:
                    return self.finish(f"шаг {key}: по сценарию стоп" if key in sc["answers"] else f"шаг {key}: нет ответа в сценарии")
                files = []
                if pending_mats:                      # «ask»: материалы — ответом на первый вопрос (обычно шаг 0)
                    ans = mat_text if key == "0" else (mat_text + "\n" + ans).strip()
                    files, pending_mats = pending_mats, []
                if len(self.turns) >= a.max_turns:
                    return self.finish(f"лимит ходов {a.max_turns}")
                turn = self.say(ans, files)
                turn.update(answers=key, scripted=scripted)
                retries = 0
                continue
            self.record(turn)
            if turn["end"] == "done":
                return self.finish("все шаги пройдены")
            if len(self.turns) >= a.max_turns:
                return self.finish(f"лимит ходов {a.max_turns}")
            if turn["end"] == "stuck":
                if retries >= a.retries:
                    return self.finish("stuck: " + (turn.get("question") or ""))
                retries += 1
                turn = self.say("", retry=True)
                continue
            if turn["end"] == "crash":
                return self.finish(f"драйвер упал (код {turn['exit']})")
            turn = self.say("")                         # лимит шагов на ход: продолжить без нового ответа


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--driver", choices=sorted(DRIVERS), required=True)
    ap.add_argument("--ws", required=True)
    ap.add_argument("--record", required=True)
    ap.add_argument("--pipeline", required=True)
    ap.add_argument("--page", default="landing")
    ap.add_argument("--script", default=str(HERE / "owner-e8p.json"))
    ap.add_argument("--first", help="первое сообщение (по умолчанию из сценария)")
    ap.add_argument("--materials", help="папка с материалами владельца")
    ap.add_argument("--materials-with", choices=["first", "ask"], default="first",
                    help="first: с первым сообщением; ask: ответом на первый вопрос (так было в E8p)")
    ap.add_argument("--max-turns", type=int, default=40)
    ap.add_argument("--retries", type=int, default=1)
    ap.add_argument("--model", help="модель базы (baseline.py); дирижёр берёт лестницу из stages.json")
    ap.add_argument("--key-file")
    ap.add_argument("--a6-url", default="https://a6api.com")
    ap.add_argument("--parallel5", choices=["on", "off"], help="плечо A/B шага 5 (#21): HARNESS_PARALLEL5 для run.py")
    a = ap.parse_args(argv)
    if a.driver == "run" and a.model:
        ap.error("--model только для --driver baseline: дирижёр берёт модели из stages.json")
    if Path(a.record).resolve().is_relative_to(Path(a.ws).resolve()):
        ap.error("--record внутри --ws: агент увидит запись прогона")
    Sim(a).go()


if __name__ == "__main__":
    main()
