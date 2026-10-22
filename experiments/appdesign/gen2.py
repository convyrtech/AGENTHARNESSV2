"""PRSLOY-style app mockups. Modes: text (style described in words) | ref (our dashboard screenshot as style reference via /v1/images/edits)
Usage: python3 gen2.py <model> <mode> <tag>"""
import sys, os, json, base64, time, uuid, urllib.request
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from lib import a6
HERE = os.path.dirname(os.path.abspath(__file__)); REF = os.path.join(os.path.dirname(HERE), "council", "inputs", "prsloy-b4.png")
CONTENT = ("High-fidelity UI mockup of a desktop application window, straight-on screenshot, no device frame, no people. "
 "Product: PRSLOY — an AI assistant app for ordinary non-technical people in Russia. ALL interface text in Russian, spelled exactly as given. "
 "LEFT narrow sidebar: wordmark «PRSLOY» with a small status dot «работает»; a segmented switch «Код» / «Креатив» / «Повседнев» («Креатив» selected); list of chats «Сайт для кофейни» (active), «Пост в Telegram», «Письмо арендатору»; at the bottom a button «Новый чат». "
 "TOP RIGHT: budget shown as a mechanical odometer counter «32,41» followed by «из 50 ₽ сегодня» and a small ruler with tick marks where the last 20% is red-hatched. "
 "CENTER: conversation. User message: «сделай сайт для моей кофейни, чтобы было красиво». Assistant answer is a plan card with 4 steps: "
 "«1. Понял задачу» (done), «2. Нашёл готовые решения» (done), «3. Выберите стиль» (active, with three small style thumbnails to pick from), «4. Соберу сайт» (pending). Done steps are marked with a small rust-red rubber-stamp check, not green ticks. "
 "RIGHT: preview panel titled «Предпросмотр» framed like the screen of a measuring instrument, showing a coffee shop landing page being built. "
 "BOTTOM: input field «Опишите, что нужно…» with a microphone button. ")
STYLE = ("VISUAL STYLE — exactly our brand PRSLOY: warm vintage scientific-instrument / engineering-drawing aesthetic on paper. "
 "Background warm paper #f3eee3, cards #faf7f0, ink dark brown #3b2a1e for text and thin 1px hairline frames, secondary text #7a6352, faint lines #ddd2c1, "
 "single accent rust/terracotta #a4472c, red stamp color #b23a26 used sparingly. "
 "Headings in an elegant serif (like Piazzolla), UI text in a clean geometric grotesk (like Geologica), small uppercase monospaced labels inside thin boxed tags (like «КЛЮЧ «РАБОТА» · CLAUDE CODE»). "
 "Motifs: mechanical digit counters with individual digit cells, analog gauge with a needle, rulers with tick marks, small screw/rivet circles in the corners of framed panels, dashed outline for empty slots, "
 "a small isometric line-art illustration of an instrument-like device drawn with thin brown lines. Square-ish corners (2–4px), no gradients, no neon, no glassmorphism, no drop-shadow blobs, no purple. "
 "Calm, precise, crafted, readable by a 12-year-old.")
def save(p, out):
    d = p["data"][0]
    if d.get("b64_json"): open(out, "wb").write(base64.b64decode(d["b64_json"])); return True
    if d.get("url"): urllib.request.urlretrieve(d["url"], out); return True
    return False
def text_mode(model, tag):
    body = {"model": model, "prompt": CONTENT + STYLE, "size": "1536x1024", "n": 1}
    st, h, p, raw, dt = a6.request("POST", "/v1/images/generations", body, timeout=900)
    return st, p, raw, body
def ref_mode(model, tag):
    import requests
    prompt = ("Use the attached screenshot ONLY as the style reference (colors, typography, line work, counters, gauges, framed panels, paper texture, overall mood) "
              "of our brand PRSLOY. Do NOT copy its layout or content. Create a new screen: " + CONTENT + STYLE)
    with open(REF, "rb") as f:
        r = requests.post(a6.BASE + "/v1/images/edits", headers={"Authorization": "Bearer " + a6._KEY},
                          files={"image": ("prsloy-b4.png", f, "image/png")},
                          data={"model": model, "prompt": prompt, "size": "1536x1024", "n": "1"}, timeout=900)
    try: p = r.json()
    except ValueError: p = None
    return r.status_code, p, r.text, {"model": model, "mode": "ref", "prompt": prompt}
if __name__ == "__main__":
    model, mode, tag = sys.argv[1:4]
    t0 = time.time()
    st, p, raw, body = (ref_mode if mode == "ref" else text_mode)(model, tag)
    out = os.path.join(HERE, "mockups", f"prsloy-{tag}.png")
    ok = st == 200 and isinstance(p, dict) and p.get("data") and save(p, out)
    a6._log(f"img2-{tag}", {"request": body, "status": st, "response": "image saved" if ok else raw[:800]})
    print(json.dumps({"tag": tag, "model": model, "mode": mode, "status": st, "secs": round(time.time() - t0, 1), "file": out if ok else None, "err": None if ok else raw[:300]}, ensure_ascii=False))
