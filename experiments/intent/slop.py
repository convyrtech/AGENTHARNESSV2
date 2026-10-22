"""Count typical Russian 'AI slop' markers in text outputs (per 1000 words)."""
import os, re, sys, json, collections
MARKERS = [r"в современном мире", r"давайте разберёмся|давайте разберемся", r"не просто [^,.]{1,40}, а ", r"\bэто не просто\b", r"играет (ключевую|важную) роль",
 r"в заключение", r"таким образом", r"стоит отметить", r"важно отметить", r"\bуникальн", r"погрузит(е|ь)ся", r"окунит(е|ь)ся", r"в мире, где",
 r"откройте для себя", r"незабываем", r"идеальн(ый|ое|ая|ое) (выбор|решение)", r"\bнастоящ(ий|ее|ая) (прорыв|магия)", r"раскрыть потенциал",
 r"новый уровень", r"революц", r"безграничн", r"на страже", r"путешествие в мир", r"—"]
def score(text):
    words = max(1, len(re.findall(r"\w+", text)))
    hits = {m: len(re.findall(m, text, re.I)) for m in MARKERS}
    dash = hits.pop("—"); emoji = len(re.findall(r"[\U0001F300-\U0001FAFF☀-➿]", text))
    return {"words": words, "slop_per_1k": round(1000 * sum(hits.values()) / words, 1), "dash_per_1k": round(1000 * dash / words, 1),
            "emoji": emoji, "hits": {k: v for k, v in hits.items() if v}}
if __name__ == "__main__":
    root = sys.argv[1]; res = collections.defaultdict(list)
    for rid in sorted(os.listdir(root)):
        for f in sorted(os.listdir(os.path.join(root, rid))):
            if f.endswith(".md") and ".plan." not in f:
                s = score(open(os.path.join(root, rid, f)).read()); v = f[:-3]; res[v].append(s["slop_per_1k"])
                print(rid, v, s)
    print({v: round(sum(x) / len(x), 2) for v, x in res.items()})
