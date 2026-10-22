"""Independent second opinions on the research synthesis from three model families."""
import sys, json, concurrent.futures as cf; sys.path.insert(0, 'lib'); import a6
doc = open('/home/user/research/00-synthesis.md').read()
PROMPT = ("Ниже — синтез исследования для ядра агентного харнеса (десктоп-приложение, ядро Pi, дешёвые модели через "
          "OpenAI-совместимый маркетплейс-ретранслятор, премиум-модели как планировщики/ревьюеры). Ты — независимый "
          "эксперт по агентным харнесам, тебя просят дать второе мнение. Будь критичен и конкретен, не пересказывай документ.\n\n"
          "Ответь по-русски в формате:\n"
          "1. По каждому ADR-1…ADR-15: «согласен / частично / не согласен» + 1–2 предложения почему (только там, где есть что сказать по существу).\n"
          "2. По спорным пунктам D1–D7 и решениям из раздела 4a: что бы ты сделал иначе и почему.\n"
          "3. Что упущено: важные практики, риски или эксперименты, которых нет в документе (до 7 пунктов).\n"
          "4. Топ-5 рисков проекта в порядке важности.\n"
          "5. Где документ, по-твоему, ошибается фактически (если видишь).\n\n"
          "=== ДОКУМЕНТ ===\n" + doc)
CFG = {"gpt-6.1-sol": {"reasoning_effort": "high"}, "gemini-4-argon": {}, "deepseek-v4.1-flash-1017": {"reasoning_effort": "high"}}
def ask(m):
    body = {"model": m, "messages": [{"role": "user", "content": PROMPT}], "max_tokens": 16000, **CFG[m]}
    for attempt in range(3):
        try:
            r = a6.chat_stream(dict(body, stream_options={"include_usage": True}), tag=f"opinion-{m}", timeout=1200)
        except Exception as e:
            r = {"status": f"exc {e!r}", "chunks": [], "secs": 0}
        text = "".join(((c.get("choices") or [{}])[0].get("delta") or {}).get("content") or "" for c in r["chunks"] if isinstance(c, dict))
        usage = next((c.get("usage") for c in reversed(r["chunks"]) if isinstance(c, dict) and c.get("usage")), None)
        if r["status"] == 200 and len(text) > 500:
            break
    open(f"/home/user/research/opinion-{m}.md", "w").write(f"# Второе мнение: {m}\n\n(запрос через a6api, статус {r['status']}, {r['secs']} c, usage {json.dumps(usage)})\n\n" + (text or str(r["chunks"])[:800]))
    return m, r["status"], len(text)
with cf.ThreadPoolExecutor(3) as ex:
    import os
    todo = [m for m in CFG if not os.path.exists(f"/home/user/research/opinion-{m}.md")]
    for res in ex.map(ask, todo): print(res)
