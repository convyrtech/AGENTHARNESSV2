"""'Reinventing the wheel' test: does the model reuse a proven library, and do prior-art / be-ambitious prompts change that?"""
import sys, os, json, re, threading, concurrent.futures as cf
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, os.path.join(HERE, "..", "lib")); import a6

TASKS = [
 ("dates", "Напиши на Python функцию, которая разбирает дату из строки в любом из форматов, которые пишут люди: '12.03.2024', '2024-03-12T10:00Z', 'March 3rd, 2024', '3 мар 2024', '12/03/24'. Верни datetime.",
  r"\b(dateutil|dateparser|pendulum|arrow|maya)\b"),
 ("phones", "Напиши на Python функцию, которая приводит телефонные номера (российские и иностранные, в любом написании) к единому формату E.164 и проверяет, что номер валидный.",
  r"\bphonenumbers\b"),
 ("sanitize", "Напиши на Python функцию, которая очищает HTML от пользователя перед показом на сайте, чтобы не было XSS, но оставались базовые теги форматирования (b, i, a, p, ul, li).",
  r"\b(bleach|nh3|lxml\.html\.clean|html_sanitizer|lxml_html_clean)\b"),
 ("passwords", "Напиши на Python функции для хранения паролей пользователей в базе: хэширование при регистрации и проверка при входе.",
  r"\b(bcrypt|argon2|passlib|scrypt|pbkdf2_hmac|werkzeug\.security|pwdlib)\b"),
 ("retry", "Напиши на Python обёртку для HTTP-запросов к внешнему API, которая при ошибках сети и ответах 429/5xx повторяет запрос с экспоненциальной задержкой и джиттером.",
  r"\b(tenacity|backoff|urllib3\.util\.retry|Retry\(|stamina|httpx_retries|retrying)\b"),
 ("markdown", "Напиши на Python функцию, которая превращает Markdown (заголовки, списки, ссылки, код, таблицы) в HTML.",
  r"\b(markdown|mistune|markdown_it|markdown2|commonmark|cmarkgfm|marko)\b"),
 ("num2words", "Напиши на Python функцию, которая пишет сумму прописью по-русски для счёта: 1234.56 -> 'одна тысяча двести тридцать четыре рубля 56 копеек'.",
  r"\b(num2words|num2t4ru|pytils|number_to_words)\b"),
 ("declension", "Напиши на Python функцию, которая склоняет русские слова и фразы по падежам, например 'красная машина' в родительный падеж -> 'красной машины'.",
  r"\b(pymorphy2|pymorphy3|petrovich|pytrovich|natasha)\b"),
 ("cron", "Напиши на Python функцию, которая по cron-выражению вроде '*/15 9-18 * * 1-5' возвращает время следующих 5 запусков.",
  r"\b(croniter|apscheduler|cronsim|crontab)\b"),
 ("jwt", "Напиши на Python функции, которые выпускают и проверяют JWT-токены для авторизации в моём API (HS256, срок жизни 1 час).",
  r"\b(jwt|jose|authlib|python_jose|joserfc)\b"),
]
SYS = {
 "plain": "You are a helpful coding assistant. Answer with the code and a short explanation.",
 "prior_art": ("You are a helpful coding assistant. Before writing code, check whether a well-established library or standard module already "
               "solves the problem; prefer reusing proven, maintained solutions over writing your own, and say which one you chose and why. "
               "Answer with the code and a short explanation."),
}
AMBITIOUS = ("I want a deeper version of this task, not a bigger one. Before doing it: (1) say what a top professional in this field would do "
             "here that I'm not asking for; (2) name the rawest material they would start from; (3) name the specific methods and tools "
             "(libraries) they would use; (4) say what, other than you or me, would show the result is right. Then do the task that way.\n\nTask: ")

def call(model, variant, task):
    name, prompt, pat = task
    if variant == "ambitious":
        msgs = [{"role": "system", "content": SYS["plain"]}, {"role": "user", "content": AMBITIOUS + prompt}]
    else:
        msgs = [{"role": "system", "content": SYS[variant]}, {"role": "user", "content": prompt}]
    try:
        rs = a6.chat_stream({"model": model, "messages": msgs, "max_tokens": int(os.environ.get("MAXTOK", "32000")), "stream_options": {"include_usage": True}},
                            tag=f"wh-{model}-{variant}-{name}", timeout=1200)
    except Exception as e:
        rs = {"status": f"exc {e!r}", "chunks": []}
    text = "".join(((c.get("choices") or [{}])[0].get("delta") or {}).get("content") or "" for c in rs["chunks"] if isinstance(c, dict))
    fin = next((((c.get("choices") or [{}])[0].get("finish_reason")) for c in reversed(rs["chunks"]) if isinstance(c, dict) and (c.get("choices") or [{}])[0].get("finish_reason")), None)
    j = {"choices": [{"message": {"content": text}, "finish_reason": fin}], "usage": next((c.get("usage") for c in reversed(rs["chunks"]) if isinstance(c, dict) and c.get("usage")), {})}
    r = {"status": rs["status"]}
    blocks = re.findall(r"```(\w*)[^\n]*\n(.*?)```", text, re.S)
    code = "\n".join(b for lang, b in blocks if lang.lower() in ("", "python", "py", "python3")) or text
    imports = "\n".join(l for l in code.splitlines() if re.match(r"\s*(import|from)\s", l))
    reused = bool(re.search(pat, imports))
    recommends = bool(re.search(pat.replace("\\b(", "(").replace(")\\b", ")"), text, re.I))
    u = j.get("usage") or {}
    return {"model": model, "variant": variant, "task": name, "status": r["status"], "reused": reused, "recommends": recommends, "finish": ((j.get("choices") or [{}])[0].get("finish_reason")), "imports": imports[:300],
            "code_lines": len(code.splitlines()), "out_tokens": u.get("completion_tokens"), "text": text[:300]}

if __name__ == "__main__":
    models = sys.argv[1].split(","); out = os.path.join(HERE, "results.jsonl"); lock = threading.Lock()
    jobs = [(m, v, t) for m in models for v in ("plain", "prior_art", "ambitious") for t in TASKS]
    if os.environ.get("REDO_FILE"):
        want = {tuple(x) for x in json.load(open(os.environ["REDO_FILE"]))}
        jobs = [(m, v, t) for m, v, t in jobs if (m, v, t[0]) in want]
        print("redo jobs", len(jobs))
    def run(a):
        rec = call(*a)
        with lock: open(out, "a").write(json.dumps(rec, ensure_ascii=False) + "\n")
    with cf.ThreadPoolExecutor(10) as ex: list(ex.map(run, jobs))
