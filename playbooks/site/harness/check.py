"""Harness checks that live in code, not in the prompt (E8d: the agent pasted a PNG screenshot of the owner's cabinet
and called it design, and ignored prompt bans). Usage: check.py <site_dir> <page_dir>. Exit 1 on any FAIL.
1. No raster images in the built site unless the owner allowed them by name in <page>/ALLOWED-IMAGES.txt.
2. 04-motion.md has a «Фирменный приём» section that names the etalon frame it comes from, and the site code names
   that move in a data-signature attribute (the live element that carries it)."""
import re, sys
from pathlib import Path

site, page = Path(sys.argv[1]), Path(sys.argv[2])
fails = []
allowed = set()
al = page / "ALLOWED-IMAGES.txt"
if al.exists():
    allowed = {ln.split()[0] for ln in al.read_text(encoding="utf-8").splitlines() if ln.strip() and not ln.startswith("#")}

RASTER = re.compile(r"""[\w./-]+\.(?:png|jpe?g|webp|gif|avif)\b""", re.I)
for f in site.rglob("*"):
    if f.suffix.lower() in (".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif") and f.name not in allowed:
        fails.append(f"растровая картинка в сайте: {f.relative_to(site)} (скриншоты интерфейса запрещены; "
                     f"элемент делается живым кодом: HTML/CSS/SVG)")
    if f.suffix.lower() in (".html", ".css", ".js"):
        for ref in set(RASTER.findall(f.read_text(encoding="utf-8", errors="ignore"))):
            if Path(ref).name not in allowed and not ref.startswith(("http://", "https://")):
                fails.append(f"ссылка на растровую картинку в {f.relative_to(site)}: {ref}")

motion = page / "04-motion.md"
text = motion.read_text(encoding="utf-8") if motion.exists() else ""
m = re.search(r"^##+\s*Фирменный приём[^\n]*\n(.*?)(?=^##\s|\Z)", text, re.M | re.S)
if not m:
    fails.append("в 04-motion.md нет раздела «## Фирменный приём»: какой приём движения из эталона берём (кадр, время) "
                 "и каким живым элементом страницы он станет")
elif not re.search(r"\bf\d{2}\b|\d+[.,]?\d*\s*с\b|кадр", m.group(1)):
    fails.append("в «Фирменный приём» нет ссылки на кадр эталона (f05, 11.3 с и т. п.)")
code = " ".join(f.read_text(encoding="utf-8", errors="ignore") for f in site.rglob("*") if f.suffix in (".html", ".js"))
if site.exists() and "data-signature" not in code:
    fails.append("на странице нет живого элемента с атрибутом data-signature (носитель фирменного приёма)")

# служебные заглушки в тексте страницы: поставщики a6 подменяют «OpenAI» на «[OI]» в аргументах вызовов (E8p)
STUB = re.compile(r"\[OI\]|\bTODO\b|lorem ipsum|\bundefined\b|\bNaN\b", re.I)
for f in site.rglob("*.html"):
    for m in set(STUB.findall(re.sub(r"<script.*?</script>", " ", f.read_text(encoding="utf-8", errors="ignore"), flags=re.S))):
        fails.append(f"служебная заглушка «{m}» в тексте {f.relative_to(site)}: впиши настоящее слово")

for x in sorted(set(fails)):
    print("FAIL", x)
print("харнесс:", "PASS" if not fails else f"FAIL ({len(set(fails))})")
sys.exit(1 if fails else 0)
