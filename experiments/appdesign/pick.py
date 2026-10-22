"""Opus as design selector: brand reference + N candidate mockups (shuffled order), returns JSON pick. Usage: python3 pick.py <order e.g. 1,2,3> <tag>"""
import sys, os, json, base64, re
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from lib import a6
HERE = os.path.dirname(os.path.abspath(__file__))
REF = os.path.join(os.path.dirname(HERE), "council", "inputs", "prsloy-b4.png")
CANDS = {"1": "mockups/prsloy-t1.png", "2": "mockups/prsloy-r1.png", "3": "mockups/prsloy-nb1.png"}
def img(path):
    return {"type": "image_url", "image_url": {"url": "data:image/png;base64," + base64.b64encode(open(path, "rb").read()).decode()}}
order, tag = sys.argv[1].split(","), sys.argv[2]
parts = [{"type": "text", "text": "ОБРАЗЕЦ БРЕНДА — наш существующий кабинет PRSLOY:"}, img(REF)]
for i, k in enumerate(order):
    parts += [{"type": "text", "text": f"КАНДИДАТ {chr(65+i)}:"}, img(os.path.join(HERE, CANDS[k]))]
parts.append({"type": "text", "text": (
 "Это макеты главного окна нашего десктоп-приложения ИИ-помощника для обычных людей (не технарей) из России. "
 "Выбери один макет, который берём за основу для вёрстки. Критерии: 1) похож на наш бренд (образец); 2) сдержанность — в приложении сидят часами; "
 "3) реально сверстать кодом с точностью 80–90%; 4) читаемость для казуала: крупность, контраст, понятность; 5) ошибки (опечатки, английский текст, бессмыслица). "
 "Ответь только JSON: {\"best\": \"A|B|C\", \"why\": \"2–3 предложения\", \"borrow\": [\"что взять из других кандидатов, с буквой\"], \"fix\": [\"что исправить в выбранном\"], \"ranking\": [\"лучший\", \"средний\", \"худший\"]}")})
body = {"model": "claude-opus-5-5", "max_tokens": 16000, "reasoning_effort": "high", "stream_options": {"include_usage": True},
        "messages": [{"role": "user", "content": parts}]}
r = a6.chat_stream(body, tag=f"pick-{tag}", timeout=900)
text = "".join(((c.get("choices") or [{}])[0].get("delta") or {}).get("content") or "" for c in r["chunks"] if isinstance(c, dict))
m = re.search(r"\{.*\}", text, re.S)
res = json.loads(m.group(0)) if m else {"raw": text[:500]}
mapping = {chr(65+i): k for i, k in enumerate(order)}
res["best_original_number"] = mapping.get(res.get("best"))
res["ranking_original"] = [mapping.get(x[:1]) for x in res.get("ranking", [])]
res["order"] = order
print(json.dumps(res, ensure_ascii=False, indent=1))
