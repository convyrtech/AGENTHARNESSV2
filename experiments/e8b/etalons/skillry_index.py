"""Build a searchable index of the skillry.dev Opus 5.5 video catalog (418 clips: prompt, category, stack, mp4).
The owner's own method: the model searches these examples, tears them down frame by frame and takes style and motion
from them. Taste comes from curated examples, not from the model's memory (E8b/E8c: memory gives Stripe/Resend)."""
import re, sys, json, urllib.request

URL = "https://skillry.dev/ai-videos/opus-5-5"
out = sys.argv[1] if len(sys.argv) > 1 else "skillry-index.json"
page = urllib.request.urlopen(urllib.request.Request(URL, headers={"User-Agent": "Mozilla/5.0"}), timeout=60).read().decode("utf-8", "ignore")


def field(rec, name):
    m = re.search(name + r':"((?:[^"\\]|\\.)*)"', rec)
    if not m:
        return None
    raw = m.group(1)
    try:
        return json.loads('"' + re.sub(r"\\x([0-9A-Fa-f]{2})", r"\\u00\1", raw) + '"')
    except ValueError:
        return raw


def num(rec, name):
    m = re.search(name + r':([0-9.]+)', rec)
    return float(m.group(1)) if m else None


items = []
for rec in page.split('{slug:"')[1:]:
    slug = rec.split('"', 1)[0]
    rec = rec[:20000]
    tags = re.search(r'techTags:\$R\[\d+\]=\[([^\]]*)\]', rec)
    items.append({
        "slug": slug,
        "page": f"{URL}/{slug}",
        "author": field(rec, "authorHandle"),
        "category": field(rec, "category"),
        "tech": re.findall(r'"([^"]+)"', tags.group(1)) if tags else [],
        "seconds": num(rec, "durationSeconds"),
        "size": [num(rec, "width"), num(rec, "height")],
        "prompt": field(rec, "prompt"),
        "promptTruncated": "promptTruncated:!0" in rec,
        "original_mp4": field(rec, "originalPreviewUrl"),
        "remake_mp4": field(rec, "remakePreviewUrl"),
        "poster": field(rec, "posterUrl"),
        "added": field(rec, "addedAt"),
    })
json.dump(items, open(out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
cats = {}
for it in items:
    cats[it["category"]] = cats.get(it["category"], 0) + 1
print(len(items), "clips", cats, "->", out)
