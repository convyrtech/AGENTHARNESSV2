"""Generate desktop-app UI mockups via a6 image models. Usage: python3 gen.py <model> <style_key> [size]"""
import sys, os, json, base64, time, urllib.request
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from lib import a6
HERE = os.path.dirname(os.path.abspath(__file__))
BASE = ("High-fidelity UI mockup of a desktop application window (Windows/macOS), straight-on screenshot, no device frame, no people. "
        "Product: an AI assistant app for ordinary non-technical people in Russia. ALL interface text in Russian, spelled exactly as given. "
        "Layout: LEFT narrow sidebar with a list of chats: «Сайт для кофейни», «Пост в Telegram», «Письмо арендатору»; above it a segmented switch with three options «Код», «Креатив», «Повседнев» («Креатив» selected). "
        "TOP bar: small budget meter «Сегодня: 32 из 50 ₽». "
        "CENTER: conversation. User bubble: «сделай сайт для моей кофейни, чтобы было красиво». Assistant answer is a compact plan card with 4 steps: "
        "«1. Понял задачу» (done, check mark), «2. Нашёл готовые решения» (done, check mark), «3. Выберите стиль» (active) with three small style thumbnails to pick from, «4. Соберу сайт» (pending). "
        "RIGHT: live preview panel titled «Предпросмотр» showing a coffee shop landing page being built. "
        "BOTTOM: input field with placeholder «Опишите, что нужно…» and a microphone icon. "
        "Calm, uncluttered, generous spacing, clear hierarchy, readable by a 12-year-old. Avoid: purple-blue gradients, neon glow, generic stat cards. ")
STYLES = {
 "warm": "Visual style: warm minimalism — off-white paper background, warm graphite text, a single terracotta accent color, soft subtle shadows, 12px rounded corners, clean grotesk sans-serif typeface with Cyrillic.",
 "dark": "Visual style: confident dark editorial — deep charcoal surfaces, one acid-lime accent used sparingly, elegant serif for headings and grotesk for UI, thin hairline dividers, high contrast, no glow.",
 "friendly": "Visual style: friendly and playful — soft pastel color blocks (peach, mint, butter yellow), chunky rounded shapes, a small cute round assistant mascot avatar, bold rounded sans-serif with Cyrillic.",
}
def gen(model, key, size="1536x1024"):
    body = {"model": model, "prompt": BASE + STYLES[key], "size": size, "n": 1}
    t0 = time.time()
    st, h, p, raw, dt = a6.request("POST", "/v1/images/generations", body, timeout=900)
    out = os.path.join(HERE, "mockups", f"{model}-{key}.png")
    ok = False
    if st == 200 and isinstance(p, dict) and p.get("data"):
        d = p["data"][0]
        if d.get("b64_json"):
            open(out, "wb").write(base64.b64decode(d["b64_json"])); ok = True
        elif d.get("url"):
            urllib.request.urlretrieve(d["url"], out); ok = True
    a6._log(f"img-{model}-{key}", {"request": body, "status": st, "secs": dt, "response": (raw[:500] if not ok else "image saved"), "usage": (p or {}).get("usage") if isinstance(p, dict) else None})
    return {"model": model, "style": key, "status": st, "secs": round(time.time() - t0, 1), "file": out if ok else None, "err": None if ok else raw[:300]}
if __name__ == "__main__":
    print(json.dumps(gen(sys.argv[1], sys.argv[2], *(sys.argv[3:4])), ensure_ascii=False))
