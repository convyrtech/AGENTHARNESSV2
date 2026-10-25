"""Вопросы «да/нет» судьи (research/20 §9): после свободного разбора судья обязательно отвечает на 12 фиксированных
вопросов, вердикт считает код. Раунд 2+ перепроверяет только «нет» прошлого раунда.

Зачем: в E9 открытые находки судьи росли 2 → 7 → 14 по раундам, в A/B сессия упёрлась в лимит раундов и задала
владельцу 3 лишних вопроса. Приём — Open CoDesign (MIT, © 2026 OpenCoworkAI Contributors),
`packages/core/src/tools/verify-ui-kit-visual-parity.ts`: одни и те же булевы вопросы на каждом прогоне, причина в одно
предложение, неотвеченный вопрос = «нет», статус из числа «да»; «yes/no is harder to fudge than a number». Вопросы свои —
по находкам E8–E9 (DIARY.md), в скобках у каждого — откуда он.

Ответ судьи — блок в JUDGE.md (в ограде ```, чтобы таблица находок flow.py его не видела):

## Вопросы «да/нет»
```
Q1 ДА — первый экран: «Claude без VPN, картой РФ».
Q5 НЕТ — «47,128 ₽» нет в FACTS. Где: 390, y=1200
```
"""
import re

# id, вопрос, серьёзность «нет», откуда (E8–E9)
QUESTIONS = [
    ("Q1", "Смысл понятен с первого экрана: что это, для кого и что делать — без прокрутки?", "Major",
     "E8d «[OI]» вместо OpenAI; E9 шаг 2a — смысл"),
    ("Q2", "Главное действие (кнопка или команда) видно на первом экране на 390 и 1440?", "Major",
     "E8q пустой «Начать»"),
    ("Q3", "Нет дублей: один и тот же блок, число или шкала не повторяются?", "Minor",
     "E8d дубль шкалы, E8 повторы"),
    ("Q4", "Нет элементов без функции: пустых кнопок, ссылок в никуда, заглушек (карта, «скоро»)?", "Major",
     "E8q заглушка карты, пустой «Начать»"),
    ("Q5", "Каждое число на странице есть в FACTS и записано одинаково (одно значение — один формат)?", "Major",
     "E8d одно число в трёх форматах, «47,128 ₽» против лимита 50 ₽; E8q числа приборов не сходятся, «10–990 ₽»"),
    ("Q6", "Цвета и шрифты — бренда владельца из 02-brand.md (не чужая палитра, не системный шрифт)?", "Major",
     "E8k бренд из источников, E9 brand.json"),
    ("Q7", "На 390 всё читаемо: основной текст не мельче 14 px, подписи и метки не мельче 11 px, ничего не вылезает "
     "вбок, код и длинные строки переносятся?", "Major", "E8d мелкий текст на снимках; E8q код не переносится"),
    ("Q8", "Фирменный приём из 04-motion.md на месте и заметен (живой элемент, не картинка)?", "Minor",
     "E8k раздел «Фирменный приём», PNG вместо живого прибора"),
    ("Q9", "Движение не мешает читать: в конечном кадре текст на месте, интро не прячет смысл?", "Minor",
     "E8d первые миллисекунды интро; E9 ложные находки по кадрам середины анимации"),
    ("Q10", "Нет шаблонных приёмов: нумерации «01/02/03», одинаковых карточек-иконок, «генерик»-героя?", "Minor",
     "DIARY: «базовый генерик-слоп», шаблонные 01/02/03"),
    ("Q11", "Нет пустых полос между секциями и обрывов фона?", "Minor", "E9 пустые полосы между секциями"),
    ("Q12", "Весь текст по-русски, без заглушек, английских обрывков и искажённых названий?", "Major",
     "E8d «[OI]», английский текст, «пример» у демо-чисел"),
]
IDS = [q[0] for q in QUESTIONS]
SEVERITY = {q[0]: q[2] for q in QUESTIONS}
HEADING = "## Вопросы «да/нет»"

CARRIED = re.compile(r"(\s*\(раунд \d+\))+\s*$")
ANSWER = re.compile(r"^\s*[-*]?\s*([QqQ]\d{1,2})\s*[:.)]?\s*(ДА|НЕТ|YES|NO|да|нет)\b\s*[—–:-]?\s*(.*)$", re.M)


def block_prompt(rnd, prev=None):
    """Задание судье. Раунд 1 — все вопросы. Раунд 2+ — только «нет» прошлого раунда, новых находок не искать."""
    if rnd <= 1 or not prev:
        ask = IDS
        head = ("\n\n## Обязательно после разбора: вопросы «да/нет»\n"
                "После таблицы находок и раздела «не проверила» добавь раздел «" + HEADING + "» и ответь на КАЖДЫЙ "
                "вопрос строкой внутри ограды ```: «Qn ДА — причина в одно предложение» или «Qn НЕТ — причина. "
                "Где: селектор или регион». «ДА» — только если по снимкам это видно; не видно — «НЕТ». "
                "Вопрос без ответа считается «НЕТ».\n")
    else:
        ask = [q for q in IDS if not prev.get(q, {}).get("yes")]
        head = ("\n\n## Раунд " + str(rnd) + ": перепроверка\n"
                "Прошлые «ДА» не пересматривай. Перепроверь по новым снимкам ТОЛЬКО вопросы ниже — это «НЕТ» прошлого "
                "раунда — и ответь на каждый в разделе «" + HEADING + "» тем же форматом внутри ```. "
                "Новых находок не добавляй, кроме Blocker (страница сломана: не открывается, текст не читается, "
                "главное действие не работает). В таблице находок оставь только перепроверенное и новые Blocker.\n")
        head += "".join(f"- {q} было НЕТ: {prev[q].get('reason', '')}\n" for q in ask if q in prev)
    qs = {q[0]: q[1] for q in QUESTIONS}
    return head + "".join(f"- {q}. {qs[q]}\n" for q in ask)


def parse(text):
    """Ответы из раздела «Вопросы «да/нет»»: {id: {"yes": bool, "reason": str}}. Чужие строки не берём."""
    i = text.find(HEADING)
    part = text[i:] if i >= 0 else ""
    out = {}
    for m in ANSWER.finditer(part):
        q, word, reason = m.group(1).upper(), m.group(2).upper(), m.group(3).strip()
        if q in SEVERITY and q not in out:
            reason = CARRIED.sub("", reason).strip()          # метку раунда ставит render, модель её повторяет
            out[q] = {"yes": word in ("ДА", "YES"), "reason": reason[:300]}
    return out


def missing(answers, asked):
    return [q for q in asked if q not in answers]


def merge(prev, cur, rnd):
    """Итог раунда: прошлые «да» остаются, перепроверенные — из ответа, неотвеченные — «нет»."""
    out = {}
    for q in IDS:
        if rnd > 1 and prev and prev.get(q, {}).get("yes"):
            out[q] = dict(prev[q], round=prev[q].get("round", rnd - 1))
        elif q in cur:
            out[q] = dict(cur[q], round=rnd)
        else:
            out[q] = {"yes": False, "reason": "судья не ответил", "round": rnd}
    return out


def verdict(answers, blockers=0):
    """PASS: все «да» или одно «нет» уровня Minor, и нет открытых Blocker/Critical в таблице находок."""
    no = [q for q in IDS if not answers.get(q, {}).get("yes")]
    if blockers:
        return "FAIL", no
    if not no or (len(no) == 1 and SEVERITY[no[0]] == "Minor"):
        return "PASS", no
    return "FAIL", no


def render(answers):
    """Полный блок для JUDGE.md: все 12, у перенесённых — раунд ответа."""
    lines = []
    for q in IDS:
        a = answers[q]
        mark = "ДА" if a["yes"] else "НЕТ"
        carried = f" (раунд {a['round']})" if a.get("round") else ""
        lines.append(f"{q} {mark} — {a['reason']}{carried}")
    yes = sum(1 for q in IDS if answers[q]["yes"])
    return f"{HEADING}\n\nДА: {yes}/{len(IDS)}\n\n```\n" + "\n".join(lines) + "\n```\n"


def apply(text, answers, final):
    """Ответ судьи с вердиктом кода и полным блоком вопросов (блок судьи заменяется, вердикт — первой строкой)."""
    i = text.find(HEADING)
    if i >= 0:
        j = text.find("\n## ", i + len(HEADING))
        rest = text[j + 1:] if j >= 0 else ""
        text = text[:i].rstrip() + "\n\n" + render(answers) + ("\n" + rest if rest else "")
    else:
        text = text.rstrip() + "\n\n" + render(answers)
    if re.search(r"(?m)^\s*JUDGE-VERDICT\s*:\s*\w+", text):
        text = re.sub(r"(?m)^\s*JUDGE-VERDICT\s*:\s*\w+", f"JUDGE-VERDICT: {final}", text, count=1)
    else:
        text = f"JUDGE-VERDICT: {final}\n" + text
    return text
