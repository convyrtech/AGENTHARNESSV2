"""Refine the chosen mockup via /v1/images/edits. Usage: python3 refine.py <tag>"""
import sys, os, json, base64, time, requests
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from lib import a6
HERE = os.path.dirname(os.path.abspath(__file__))
PROMPT = ("Keep this exact screen — same layout, same PRSLOY brand style (warm paper #f3eee3, dark brown ink #3b2a1e, rust accent #a4472c, thin hairline frames with small rivets, the small isometric instrument drawing), same content — and apply ONLY these changes: "
 "1) Top bar budget: make the mechanical odometer counter «32,41» much larger and bolder, with individual digit cells, followed by «из 50 ₽ сегодня», and the ruler with tick marks where the last 20% is red-hatched. "
 "2) Done plan steps: replace square checkboxes with round rust-red rubber-stamp check marks. "
 "3) Typography: serif font ONLY for the wordmark «PRSLOY» and headings («Предпросмотр», plan title); all other UI text (chat list, buttons, segmented switch, messages, input placeholder, step descriptions) in a clean geometric grotesk sans-serif with Cyrillic, like Geologica. "
 "4) Make all text 15–20% larger and buttons/rows taller and easier to click; increase text contrast — main text dark brown #3b2a1e, never pale. "
 "5) Fix the switch labels to exactly «Код», «Креатив», «Повседнев». All text in Russian, spelled exactly.")
tag = sys.argv[1]
t0 = time.time()
with open(os.path.join(HERE, "mockups", "prsloy-r1.png"), "rb") as f:
    r = requests.post(a6.BASE + "/v1/images/edits", headers={"Authorization": "Bearer " + a6._KEY},
                      files={"image": ("prsloy-r1.png", f, "image/png")},
                      data={"model": "gpt-image-2.5", "prompt": PROMPT, "size": "1536x1024", "n": "1"}, timeout=900)
p = r.json() if r.headers.get("content-type", "").startswith("application/json") else None
out = os.path.join(HERE, "mockups", f"prsloy-r1-{tag}.png"); ok = False
if r.status_code == 200 and p and p.get("data"):
    d = p["data"][0]
    if d.get("b64_json"): open(out, "wb").write(base64.b64decode(d["b64_json"])); ok = True
a6._log(f"refine-{tag}", {"status": r.status_code, "prompt": PROMPT, "response": "saved" if ok else r.text[:800]})
print(json.dumps({"tag": tag, "status": r.status_code, "secs": round(time.time() - t0, 1), "file": out if ok else None}, ensure_ascii=False))
