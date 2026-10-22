"""Diagnose Opus routes on a6: plain vs reasoning_effort=high. (1) OCR of exact UI text from one image, (2) pairwise pick consistency."""
import sys, os, json, re, itertools, concurrent.futures as cf
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import pick2 as P
from lib import a6
P.MODELS["opus_plain"] = ("claude-opus-5-5", {})
P.MODELS["opus_high"] = ("claude-opus-5-5", {"reasoning_effort": "high"})
OCR_Q = ("Перепиши дословно, без пересказа: 1) три подписи переключателя под логотипом; 2) названия трёх чатов в левой колонке; "
         "3) текст бюджета вверху справа; 4) подписи трёх миниатюр стилей в шаге 3. Ответь только JSON: {\"switch\": [], \"chats\": [], \"budget\": \"\", \"thumbs\": []}")
TRUTH = {"switch": ["Код", "Креатив", "Повседнев"], "chats": ["Сайт для кофейни", "Пост в Telegram", "Письмо арендатору"], "thumbs": ["Минималистичный", "Классический", "Уютный"]}
def ocr(model_key):
    model, extra = P.MODELS[model_key]
    parts = [P.labelled(os.path.join(P.HERE, "mockups", "prsloy-r1-v1.png"), "МАКЕТ"), {"type": "text", "text": OCR_Q}]
    body = {"model": model, "max_tokens": 8000, "stream_options": {"include_usage": True}, "messages": [{"role": "user", "content": parts}], **extra}
    r = a6.chat_stream(body, tag=f"ocr-{model_key}", timeout=600)
    ch = [c for c in r["chunks"] if isinstance(c, dict)]
    t = "".join(((c.get("choices") or [{}])[0].get("delta") or {}).get("content") or "" for c in ch)
    u = [c["usage"] for c in ch if c.get("usage")]; mid = next((c.get("id") for c in ch if c.get("id")), None)
    m = re.search(r"\{.*\}", t, re.S); j = {}
    try: j = json.loads(m.group(0)) if m else {}
    except ValueError: pass
    hits = sum(1 for k in TRUTH for w in TRUTH[k] if w in (j.get(k) or []))
    return {"model": model_key, "ocr_exact": f"{hits}/9", "budget": j.get("budget"), "switch": j.get("switch"), "id": str(mid)[:16], "in_tok": u[-1].get("prompt_tokens") if u else None}
if __name__ == "__main__":
    with cf.ThreadPoolExecutor(8) as ex:
        o = list(ex.map(ocr, ["opus_plain", "opus_high", "gemini4", "gpt61"]))
        jobs = [(m, a, b) for m in ["opus_plain"] for a, b in itertools.permutations("123", 2)]
        res = list(ex.map(lambda j: P.judge(*j), jobs))
    for x in o: print(json.dumps(x, ensure_ascii=False))
    owner_better = {("2", "1"), ("2", "3"), ("1", "3")}
    agree = sum(1 for r in res if r["winner"] and (r["winner"], r["y"] if r["winner"] == r["x"] else r["x"]) in owner_better)
    consist = sum(1 for a, b in itertools.combinations("123", 2)
                  if (x := next((r["winner"] for r in res if (r["x"], r["y"]) == (a, b)), None)) and x == next((r["winner"] for r in res if (r["x"], r["y"]) == (b, a)), None))
    print(f"opus_plain pairwise: agree {agree}/6, consistent {consist}/3, wins {[sum(r['winner']==k for r in res) for k in '123']}")
    json.dump({"ocr": o, "pairwise_plain": res}, open(os.path.join(P.HERE, "diag-results.json"), "w"), ensure_ascii=False, indent=1)
