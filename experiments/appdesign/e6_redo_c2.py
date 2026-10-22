"""Redo E6 sample c2 with the mockup the pickers actually chose (mock1); the first c2 was built on mock0 because of a parsing bug."""
import sys, os, json, time, random
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import e6
mocks = [os.path.join(e6.OUT, "c2-mock0.png"), os.path.join(e6.OUT, "c2-mock1.png")]
e6.mockup = lambda i, tag: mocks[i] if i < 2 else None
chosen, votes = e6.pick(mocks, "c2redo")
print("pick:", os.path.basename(chosen), votes)
e6.pick = lambda m, tag: (chosen, votes)
t0 = time.time(); info = e6.pipeline("c", 2)
k = json.load(open(os.path.join(e6.OUT, "key-do-not-open.json")))
k["infos"] = [i for i in k["infos"] if not (i["variant"] == "c" and i["sample"] == 2)] + [info]
k["note"] = "c2 rebuilt on the mockup the pickers chose (mock1); first c2 used mock0 due to a parsing bug, moved to discarded/"
from PIL import Image, ImageDraw, ImageFont
L = k["key"]["c2"]
im = Image.open(os.path.join(e6.OUT, "c2-final.png")).convert("RGB"); out = Image.new("RGB", (im.width, im.height + 80), "white"); out.paste(im, (0, 80))
ImageDraw.Draw(out).text((24, 12), f"Вариант {L}", fill="black", font=ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 52)); out.save(os.path.join(e6.OUT, f"BLIND-{L}.png"))
k["t_redo"] = [t0, time.time()]
json.dump(k, open(os.path.join(e6.OUT, "key-do-not-open.json"), "w"), ensure_ascii=False, indent=1)
print("done", info["secs"], info.get("mock"), info.get("mock_votes"))
