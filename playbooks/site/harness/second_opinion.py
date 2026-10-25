"""Second opinion before the owner sees anything: a model of another family checks the agent's outgoing message and the
pictures it shows against a fixed list of concrete questions (not «make it better»: E7 showed a general critic pulls
toward the template). Usage: second_opinion.py <workspace> <message_file> [--model a6/<id>].
Prints JSON {verdict, items:[{check, ok, evidence}]} and exits 1 on FAIL."""
import os, re, sys, json, base64, argparse, urllib.request
from pathlib import Path
for _s in (sys.stdout, sys.stderr):  # Windows: под -I PYTHONUTF8 не действует, а вывод в трубу идёт в cp1252
    _s.reconfigure(encoding="utf-8", errors="replace")

ap = argparse.ArgumentParser()
ap.add_argument("workspace"); ap.add_argument("message")
ap.add_argument("--model", default="deepseek-v4.1-flash-1017")
ap.add_argument("--proxy", default="http://127.0.0.1:8787", help="прокси надёжности a6proxy.py: ключ держит он")
ap.add_argument("--gate", default="", help="шаг пайплайна: на шаге 0a до трёх вопросов — норма")
ap.add_argument("--known", default="", help="что владелец уже сказал или прислал (чтобы не просить второй раз)")
a = ap.parse_args()
ws = Path(a.workspace)
msg = Path(a.message).read_text(encoding="utf-8")
model = a.model.split("/", 1)[-1]

# pictures the owner will see: every .png path named in the message, plus the page contact sheets once the page is built
imgs = []
for ref in re.findall(r"[\w./-]+\.png", msg):
    p = (ws / ref) if not ref.startswith("/") else Path(ref)
    if p.exists() and p not in imgs:
        imgs.append(p)
vg = sorted(ws.glob("design/*/artifacts/visual-gate/contact-chromium-*.png"))
if vg and re.search(r"страниц|выклад|готов", msg, re.I):
    imgs += [p for p in vg if p not in imgs][:3]

CHECKS = [
    ("lang", "Текст сообщения по-русски. Адреса (https://…), пути к картинкам, названия продуктов и моделей латиницей — "
             "допустимы и нарушением не считаются."),
    ("casual", "Понятно человеку без технических знаний: нет слов «линтер», «гейт», «flow», «ворота», «контраст», "
               "«селектор», путей к служебным файлам кроме картинки или видео; " +
               ("не длиннее 16 строк." if a.gate == "0a" else "не длиннее 8 строк.")),
    (("questions", "Не больше трёх вопросов; у каждого 2–4 варианта буквами и ровно один вариант с «(рекомендую)».")
     if a.gate == "0a" else
     ("one_question", "В сообщении ровно один вопрос (или одна группа вариантов) и своя рекомендация.")),
    ("no_repeat_ask", "Сообщение не просит у владельца то, что он уже сказал или прислал (см. «Уже известно» ниже; "
                      "если там пусто — ok)."),
    ("no_empty", "На картинках нет пустых блоков, рамок-заглушек без содержания, недорисованных элементов."),
    ("no_broken", "На картинках нет сломанных элементов: цифры или текст вылезают из рамок, наезжают, обрезаны."),
    ("no_dupes", "Нет дублей: одно и то же число или подпись не повторяется в соседних блоках без нового смысла."),
    ("no_screens", "На картинках страницы нет вставленных скриншотов чужого интерфейса или кабинета вместо своих элементов."),
    ("consistent", "Числа-примеры согласованы между собой (одна сумма не противоречит другой)."),
    ("no_stubs", "В тексте и на картинках нет служебных заглушек: «[OI]», «TODO», «lorem», «<...>», «undefined», «NaN»."),
]
# шаг 3: картинки — кадры чужих референсов, правила «своей страницы» к ним не относятся. Шаг 1 (moves.py): кадры —
# наши приёмы в бренде владельца, пустые и сломанные кадры недопустимы; скриншотов и согласованных чисел там нет
# на шаге 8 страница уже принята владельцем (шаг 7): правка по картинке откатила бы его согласие (E9) — только текст
if a.gate == "8":
    CHECKS = [c for c in CHECKS if c[0] not in ("no_empty", "no_broken", "no_dupes", "no_screens", "consistent")]
if a.gate in ("1", "3"):
    drop = ("no_dupes", "no_screens", "consistent") if a.gate == "1" else \
        ("no_empty", "no_broken", "no_dupes", "no_screens", "consistent")
    CHECKS = [c for c in CHECKS if c[0] not in drop]
    CHECKS.append(("distinct", "На листе не меньше трёх РАЗНЫХ вариантов, у каждого подпись (буква), их легко различить."))
prompt = ("Ты проверяющий. Агент собирается показать владельцу сообщение и картинки. Проверь КАЖДЫЙ пункт строго по "
          "тому, что видно и написано. Не советуй, как сделать красивее. Если пункт не к чему применить (например, "
          "картинок нет), ставь ok=true с evidence «не применимо».\n\nПункты:\n" +
          "\n".join(f"- {k}: {t}" for k, t in CHECKS) +
          "\n\nОтвет: ровно по одной строке на пункт, в формате `<ключ> | да | <что видно, где>` или "
          "`<ключ> | нет | <что видно, где>`. Больше ничего.\n\nУже известно от владельца:\n" + (a.known or "(пусто)") +
          "\n\nСообщение владельцу:\n<<<\n" + msg + "\n>>>")
content = [{"type": "text", "text": prompt}]
for p in imgs[:5]:
    content.append({"type": "text", "text": f"Картинка: {p.name}"})
    content.append({"type": "image_url", "image_url": {"url": "data:image/png;base64," + base64.b64encode(p.read_bytes()).decode()}})
body = {"model": model, "max_tokens": 16000, "messages": [{"role": "user", "content": content}]}
req = urllib.request.Request(a.proxy.rstrip("/") + "/v1/chat/completions", data=json.dumps(body).encode(),
                             headers={"Authorization": "Bearer local", "Content-Type": "application/json"})
out = {"verdict": "ERROR", "items": [], "model": model, "images": [p.name for p in imgs[:5]]}
for attempt in range(3):
    try:
        d = json.load(urllib.request.urlopen(req, timeout=300))
        ch = d["choices"][0]
        text = ch["message"].get("content") or ""
        out["finish"] = ch.get("finish_reason")
        out["raw"] = text[-300:]
        keys = {k for k, _ in CHECKS}
        items = []
        for ln in text.splitlines():
            parts = [x.strip(" `*") for x in ln.split("|")]
            if len(parts) >= 3 and parts[0] in keys:
                items.append({"check": parts[0], "ok": parts[1].lower().startswith("да"), "evidence": "|".join(parts[2:]).strip()})
        out["items"] = items
        out["verdict"] = "PASS" if items and all(i.get("ok") for i in items) else ("FAIL" if items else "ERROR")
        break
    except Exception as e:  # supplier timeouts happen (E8q): retry, then report ERROR without blocking the owner
        out["error"] = repr(e)[:200]
print(json.dumps(out, ensure_ascii=False, indent=1))
sys.exit(1 if out["verdict"] == "FAIL" else 0)
