"""E6 variant d (owner's Claude Code practice): two coded variants -> builder compares screenshots and proposes a hybrid -> builds it.
Same builder, same inputs, same number of builder calls (3) as a/b/c. Then reshuffle all 8 finals into a new blind set."""
import sys, os, json, time, random, concurrent.futures as cf
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import e6
from e6 import ask, BUILDER, build_parts, TECH, html_of, render, img, OUT
def pipeline_d(sample):
    tag = f"d{sample}"; t0 = time.time()
    notes = ["Вариант 1 из 2.", "Вариант 2 из 2: предложи другую компоновку, отличную от самой очевидной."]
    with cf.ThreadPoolExecutor(2) as ex:
        htmls = list(ex.map(lambda n: html_of(ask(BUILDER, build_parts([{"type": "text", "text": n + " " + TECH}]), f"{tag}-v{notes.index(n)+1}")), notes))
    shots = []
    for i, h in enumerate(htmls):
        p = os.path.join(OUT, f"{tag}-v{i+1}.png"); render(h, p); shots.append(p)
    parts = build_parts([{"type": "text", "text": "Вариант 1 (код):\n```html\n" + htmls[0] + "\n```"}, {"type": "text", "text": "Скриншот варианта 1:"}, img(shots[0]),
                         {"type": "text", "text": "Вариант 2 (код):\n```html\n" + htmls[1] + "\n```"}, {"type": "text", "text": "Скриншот варианта 2:"}, img(shots[1]),
                         {"type": "text", "text": "Сравни два варианта как арт-директор: коротко (до 6 пунктов) напиши, что берёшь из каждого и что исправляешь, затем сверстай ГИБРИД. " + TECH}])
    raw = ask(BUILDER, parts, f"{tag}-hybrid")
    open(os.path.join(OUT, f"{tag}-hybrid-notes.md"), "w").write(raw.split("```html")[0][:4000])
    final = os.path.join(OUT, f"{tag}-final.png"); r = render(html_of(raw), final)
    return {"variant": "d", "sample": sample, "secs": round(time.time() - t0), "render_final": r}
if __name__ == "__main__":
    t0 = time.time()
    with cf.ThreadPoolExecutor(2) as ex: infos = list(ex.map(pipeline_d, (1, 2)))
    k = json.load(open(os.path.join(OUT, "key-do-not-open.json")))
    k["infos"] += infos
    tags = [f"{v}{s}" for v in "abcd" for s in (1, 2)]
    letters = list("ABCDEFGH"); random.Random("e6-blind-8").shuffle(letters)
    k["key_v1_unused"] = k["key"]; k["key"] = dict(zip(tags, letters)); k["t_d"] = [t0, time.time()]
    for f in os.listdir(OUT):
        if f.startswith("BLIND-"): os.remove(os.path.join(OUT, f))
    from PIL import Image, ImageDraw, ImageFont
    for tag, L in k["key"].items():
        im = Image.open(os.path.join(OUT, f"{tag}-final.png")).convert("RGB"); out = Image.new("RGB", (im.width, im.height + 80), "white"); out.paste(im, (0, 80))
        ImageDraw.Draw(out).text((24, 12), f"Вариант {L}", fill="black", font=ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 52)); out.save(os.path.join(OUT, f"BLIND-{L}.png"))
    json.dump(k, open(os.path.join(OUT, "key-do-not-open.json"), "w"), ensure_ascii=False, indent=1)
    print("done", [(i["sample"], i["secs"], i["render_final"]) for i in infos])
