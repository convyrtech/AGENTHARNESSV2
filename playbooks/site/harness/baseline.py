"""База для A/B: одна сессия Pi ведёт весь пайплайн (как experiments/e8b/drive.py в E8p), без дирижёра.

Чтобы сравнение с run.py было честным, отличается только устройство сессий. Остальное берётся из run.py как есть:
рабочая папка (`run.py init`), правила AGENTS.md там, где они применимы, бюджет и детектор петель (`run_stage`), проверка
харнесса, второе мнение перед сообщением владельцу, судья в коде и сообщение после лимита его раундов. Модель одна,
по умолчанию Kimi K3.1 Pro (модель E8p), сессия одна (`--session` держится весь прогон).

  baseline.py init <ws> --page <имя> --pipeline <design-pipeline> [--model a6p/kimi-k3.1-pro]
  baseline.py say  <ws> "<текст владельца>" [--files f ...] [--retry]
  baseline.py status <ws>

CLI и события JSONL в stdout — те же, что у run.py: simulate.py водит любой из двух.
"""
import argparse, datetime as dt, importlib.util, json, re, shutil, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("harness_run", HERE / "run.py")
R = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(R)

MODEL = "a6p/kimi-k3.1-pro"
# бюджет одного запуска сессии (ход владельца может состоять из нескольких запусков, как у дирижёра — из шагов)
BUDGET = {"max_calls": 200, "max_minutes": 40, "same_call_limit": 3, "edits_without_check": 15}
GATE = "все"                                      # метка шага в событиях и журнале: сессия одна на все шаги

# AGENTS.md дирижёра описывает «один запуск — один шаг»; для одной сессии меняется только это, остальное — те же правила
AGENTS_SWAPS = [
    ("Каждый твой запуск —\nодин шаг дизайн-пайплайна: задание шага приходит от харнесса первым сообщением. Прошлых "
     "сессий ты не видишь, память —\nфайлы страницы.",
     "Ты ведёшь всю страницу в одной\nсессии: шаг за шагом, как говорит flow.py, пока не понадобится ответ "
     "владельца. Его сообщения приходят\nсюда же; заметки харнесса помечены «[харнесс]»."),
    ("- Правила шагов: `design-pipeline/AGENTS.md` и `design-pipeline/PIPELINE.md` (нужный шаг уже вписан в задание).",
     "- Правила шагов: `design-pipeline/AGENTS.md` и `design-pipeline/PIPELINE.md`."),
    ("- Пишешь ему только в конце сессии и только", "- Пишешь ему только в конце хода и только"),
]
START = ("[харнесс] Ты ведёшь страницу design/{page} целиком в этой сессии. Где мы: `python3 -I "
         "design-pipeline/tools/flow.py --page design/{page}`. Делай шаги по порядку, пока шагу не нужен ответ владельца "
         "(выбор по листу, «да», материалы); тогда спроси его инструментом ask_owner — вызов заканчивает ход (без "
         "инструмента — сообщением ему: первая строка «{to}», дальше текст по "
         "design-pipeline/templates/OWNER-MESSAGE.md). Если остановился без вопроса владельцу, последней строкой "
         "напиши «{ok}».")


def agents_md(text):
    """AGENTS.md дирижёра → вариант для одной сессии. Каждая замена обязана лечь: правила не расходятся молча."""
    for old, new in AGENTS_SWAPS:
        if old not in text:
            raise ValueError(f"AGENTS.md изменился, замена для базы не легла: {old[:60]}…")
        text = text.replace(old, new)
    return text


def init(a):
    R.init(a)
    ws = R.WS(a.ws)
    agents = ws.root / "AGENTS.md"
    agents.write_text(agents_md(agents.read_text(encoding="utf-8")), encoding="utf-8")
    ws.state.update(mode="baseline", model=a.model)
    ws.save()


def to_owner(ws, text, files=None, options=None):
    ws.state["outbox"] = ws.state.get("outbox", 0) + 1
    sent = ws.h / "sent"
    sent.mkdir(exist_ok=True)
    (sent / f"{ws.state['outbox']:02d}.md").write_text(text + "\n", encoding="utf-8")
    if files is None:
        files = [str((ws.root / x).resolve()) for x in re.findall(r"[\w./\\-]+\.(?:png|jpe?g|mp4|webm|html)", text)
                 if (ws.root / x).exists()]
    ws.save()
    R.emit(ev="owner", text=text, files=files, options=options if options is not None else R.options_of(text))


def say(a):
    ws = R.WS(a.ws)
    model = ws.state.get("model") or MODEL
    session = ws.h / "sessions" / "baseline.jsonl"
    files = []
    for f in a.files or []:
        dst = ws.root / "materials" / Path(f).name
        shutil.copyfile(f, dst)
        files.append(f"materials/{dst.name}")
    parts = []
    if not ws.state.get("started"):
        parts.append(START.format(page=ws.state["page"], to=R.TO_OWNER, ok=R.ENDS_OK))
        ws.state["started"] = True
    if a.text:
        ws.state["turn"] = ws.state.get("turn", 0) + 1
        with open(ws.root / "owner" / "messages.jsonl", "a", encoding="utf-8") as f:
            f.write(json.dumps({"id": ws.state["turn"], "date": dt.datetime.now().strftime("%Y%m%d-%H%M%S"),
                                "text": a.text, "forward_from": None, "files": files}, ensure_ascii=False) + "\n")
        parts.append("[сообщение владельца]\n" + a.text +
                     (f"\n[владелец прислал файлы: {', '.join(files)}]" if files else ""))
    notes = list(ws.state.pop("carry_notes", []))
    # ответ после лимита судьи: то же указание, что даёт run.py
    if a.text and ws.state.pop("judge_cap_asked", False):
        if re.match(r"\s*[бb6]\b", a.text.lower()) or "исправ" in a.text.lower():
            ws.state["judge_bonus"] = ws.state.get("judge_bonus", 0) + 1
            ws.state["judge_capped"] = False
            notes.append(f"Владелец после лимита судьи ответил «{a.text}»: исправь находки Blocker и Critical, "
                         "подтверждённые кадром, перезапусти гейт и закончи «ЭТАП ГОТОВ». Харнесс даст судье ещё раунд.")
        else:
            notes.append(f"Владелец после лимита судьи ответил «{a.text}»: если это согласие выложить как есть, запиши в "
                         f"STATUS.md строку «ВЫБОР 7j: принять как есть · «{a.text}» · {dt.date.today()}» (его слова "
                         "дословно), запусти flow.py и закончи «ЭТАП ГОТОВ». Если ответ про другое — сделай, что он "
                         "просит, и закончи сообщением ему.")
    if not a.text and not notes:
        parts.append("[харнесс] Продолжай с того шага, где остановился.")
    ws.save()
    transport = 0
    prompt = "\n\n".join(parts + [f"[харнесс, не владелец]\n{n}" for n in notes])
    for _ in range(R.CFG["max_stages_per_turn"]):
        if not R.judge_intact(ws):
            R.emit(ev="stuck", text="переписку судьи меняли не через харнесс: результат судьи не принимается")
            return
        fl = R.flow(ws, "--json")
        if fl.get("exit") == 0:
            R.emit(ev="done", text="все шаги пройдены")
            return
        gate = (fl.get("next") or {}).get("gate", "?")
        R.emit(ev="stage", gate=gate, title="одна сессия", model=model, attempt=1)
        final, st = R.run_stage(ws, GATE, prompt, model, BUDGET, session)
        card = R.ask_card(st.get("ask"))              # вопрос инструментом ask_owner — как у дирижёра
        end = "owner" if card or R.TO_OWNER in final else ("ok" if R.ENDS_OK in final else "other")
        ws.ledger(kind="stage", gate=gate, model=model, attempt=1, **st, end=end)
        notes = []
        if st.get("error") and not final:
            transport += 1
            if transport > 3:
                R.emit(ev="stuck", text="связь с моделью обрывается: " + st["error"][:120])
                return
            R.emit(ev="note", text="связь с моделью оборвалась, продолжаю: " + st["error"][:120])
            prompt = "[харнесс] Связь с моделью оборвалась. Продолжай с того места, где остановился."
            continue
        if st["killed"]:
            notes.append(f"Харнесс остановил ход: {st['killed']}. Не повторяй то же; запусти flow.py и сделай то, "
                         "что он называет.")
        if st["edits_since_check"] >= BUDGET["edits_without_check"]:
            notes.append(f"Ты сделал {st['edits_since_check']} правок без проверки. После правок запускай flow.py и гейт.")
        hc = R.harness_check(ws)
        if hc:
            notes.append("Проверка харнесса (не владелец), страницу владельцу не показывать, пока это не исправлено:\n"
                         + hc.strip())
        if (card or R.TO_OWNER in final) and not hc:
            text, options = card or (final.split(R.TO_OWNER, 1)[1].strip(), None)
            for _fix in range(R.CFG["checker_retries"]):
                op = R.second_opinion(ws, text, model, gate)
                if not op or op.get("verdict") != "FAIL":
                    break
                bad = [i for i in op.get("items", []) if not i.get("ok")]
                again = "снова спроси его инструментом ask_owner" if card else f"снова закончи «{R.TO_OWNER}» и текстом"
                fix = ("[второе мнение харнесса, не владелец: сообщение владельцу НЕ ушло. Исправь это в работе и в "
                       f"сообщении, потом {again}]\n" +
                       "\n".join(f"- {i['check']}: {i['evidence']}" for i in bad))
                R.emit(ev="note", text="второе мнение вернуло сообщение: " + "; ".join(i["check"] for i in bad))
                f2, s2 = R.run_stage(ws, GATE, fix, model, BUDGET, session)
                ws.ledger(kind="fix", gate=gate, model=model, **s2)
                card2 = R.ask_card(s2.get("ask"))
                if card2:
                    text, options = card = card2
                elif R.TO_OWNER in f2:
                    text, options = f2.split(R.TO_OWNER, 1)[1].strip(), None
            to_owner(ws, text, options=options)
            return
        # без вопроса владельцу: судья в коде, как у дирижёра, когда шагу 7 не хватает только его
        fl = R.flow(ws, "--json")
        if fl.get("exit") == 0:
            R.emit(ev="done", text="все шаги пройдены")
            return
        nx = fl.get("next") or {}
        probs = nx.get("problems", [])
        if nx.get("gate") == "7" and probs and all("судь" in x for x in probs) and not ws.state.get("judge_capped"):
            fp = R.snapshots_fp(ws)
            last = ws.state.get("judge_last") or {}
            if last.get("fp") != fp or (last.get("verdict") == "PASS" and last.get("round", 0) < 2):
                code, out = R.run_judge(ws)
                R.emit(ev="note", text=f"судья: {out[-300:]}")
                if code == 0:
                    try:
                        j = json.loads(out.strip().splitlines()[-1])
                    except (ValueError, IndexError):
                        j = {}
                    ws.state["judge_last"] = {"fp": R.snapshots_fp(ws), "verdict": j.get("verdict"),
                                              "round": j.get("round")}
                    ws.save()
                    notes.append(f"Судья (раунд {j.get('round')}, {j.get('verdict')}): ответ в "
                                 "artifacts/judge/JUDGE.md. Исправь находки, подтверждённые кадром (Blocker и Critical — "
                                 "обязательно), отметь «Статус», перезапусти гейт. Судью позовёт харнесс по новым снимкам.")
                elif code == 3:
                    text, shown = R.judge_cap_message(ws)
                    ws.state["judge_cap_asked"] = True
                    ws.state["judge_capped"] = True
                    to_owner(ws, text, shown)
                    return
                elif code == 4:
                    notes.append("Судья не смотрит старые снимки: перезапусти гейт, потом продолжай.")
                else:
                    R.emit(ev="stuck", text="судья не ответил: " + out[-200:])
                    return
            else:
                notes.append(f"Судья (раунд {last.get('round')}, {last.get('verdict')}) смотрел эти снимки: исправь "
                             "находки из artifacts/judge/JUDGE.md, перезапусти гейт. Судью позовёт харнесс по новым снимкам.")
        else:
            notes.append(f"flow.py ещё не пройден, шаг {nx.get('gate')} «{nx.get('title', '')}»: " +
                         "; ".join(probs[:6]) + ". Продолжай.")
        prompt = "\n\n".join(f"[харнесс, не владелец]\n{n}" for n in notes)
    ws.state["carry_notes"] = notes
    ws.save()
    R.emit(ev="note", text="на этот ход запусков хватит; продолжу по следующему сообщению")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    sp = ap.add_subparsers(dest="cmd", required=True)
    i = sp.add_parser("init"); i.add_argument("ws"); i.add_argument("--page", required=True)
    i.add_argument("--materials"); i.add_argument("--pipeline"); i.add_argument("--model", default=MODEL)
    s = sp.add_parser("say"); s.add_argument("ws"); s.add_argument("text", nargs="?", default="")
    s.add_argument("--files", nargs="*"); s.add_argument("--retry", action="store_true")
    t = sp.add_parser("status"); t.add_argument("ws")
    a = ap.parse_args()
    {"init": init, "say": say, "status": R.status}[a.cmd](a)
