# Пять самых частых слов в text.txt.
import re
from collections import Counter

with open("text.txt", encoding="utf-8") as f:
    words = re.findall(r"[а-яёa-z]+", f.read().lower())

for word, count in Counter(words).most_common(5):
    print(f"{word}: {count}")
