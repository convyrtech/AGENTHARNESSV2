"""Stub of design-pipeline/tools/compare_sheet.py for checks without the private pipeline: image variants side by side
with their letters, plus the <out>.json sidecar flow.py reads (variants with label/target/path)."""
import argparse, json, sys
from pathlib import Path
from PIL import Image, ImageDraw

for s in (sys.stdout, sys.stderr):
    s.reconfigure(encoding="utf-8", errors="replace")
ap = argparse.ArgumentParser()
ap.add_argument("--variant", action="append", required=True)
ap.add_argument("--labels", default="A,B,C,D")
ap.add_argument("--engine", default="chromium")
ap.add_argument("--mode", default="screens")
ap.add_argument("--out", required=True)
a = ap.parse_args()
ims = [Image.open(v).convert("RGB") for v in a.variant]
for im in ims:
    im.thumbnail((1134, 844))
pad, head = 24, 56
W = sum(i.width + pad for i in ims) + pad
H = max(i.height for i in ims) + head + 2 * pad
sheet = Image.new("RGB", (W, H), (242, 240, 236))
d = ImageDraw.Draw(sheet)
labels = a.labels.split(",")
x = pad
for i, im in enumerate(ims):
    d.text((x, pad + 8), labels[i], fill=(20, 20, 20))
    sheet.paste(im, (x, pad + head))
    x += im.width + pad
out = Path(a.out)
out.parent.mkdir(parents=True, exist_ok=True)
sheet.save(out)
meta = [{"label": labels[i], "target": v, "path": str(Path(v).resolve()), "sha256": None} for i, v in enumerate(a.variant)]
out.with_suffix(".json").write_text(json.dumps({"tool": "compare_sheet", "mode": a.mode, "variants": meta,
                                               "size": [W, H]}, ensure_ascii=False, indent=1), encoding="utf-8")
print(f"compare_sheet (stub): {len(ims)} variants → {out}")
