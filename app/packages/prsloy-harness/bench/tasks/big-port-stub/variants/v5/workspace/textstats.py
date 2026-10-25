"""Статистика текста: слова, предложения, частые слова, буквы, палиндромы."""

TEXT = """Мама мыла раму, а потом мама пошла в сад. В саду росли яблоки и груши.
Шалаш стоял у реки. Казак сидел у шалаша и смотрел на воду! Вода была тихой.
А роза упала на лапу Азора. Кто сказал, что это правда? Никто не знал.
Потом пошёл дождь, и мама позвала всех домой. Дома было тепло и тихо."""

STOP = {"а", "и", "в", "у", "на", "что", "это", "не", "с", "по"}

VOWELS = set("аеёиоуыэюя")


def words(text):
    out = []
    cur = ""
    for ch in text.lower():
        if ch.isalpha() or ch == "-":
            cur += ch
        else:
            if cur:
                out.append(cur)
            cur = ""
    if cur:
        out.append(cur)
    return out


def sentences(text):
    out = []
    cur = ""
    for ch in text.replace("\n", " "):
        cur += ch
        if ch in ".!?":
            s = cur.strip()
            if s:
                out.append(s)
            cur = ""
    if cur.strip():
        out.append(cur.strip())
    return out


def frequencies(ws):
    freq = {}
    for w in ws:
        if w in STOP:
            continue
        freq[w] = freq.get(w, 0) + 1
    return freq


def top(freq, n):
    items = list(freq.items())
    items.sort(key=lambda kv: (-kv[1], kv[0]))
    return items[:n]


def letters(text):
    counts = {}
    for ch in text.lower():
        if ch.isalpha():
            counts[ch] = counts.get(ch, 0) + 1
    return counts


def is_palindrome(phrase):
    clean = "".join(ch for ch in phrase.lower() if ch.isalpha())
    return len(clean) >= 3 and clean == clean[::-1]


def syllables(word):
    return sum(1 for ch in word if ch in VOWELS)


def print_basic(text):
    ws = words(text)
    ss = sentences(text)
    print(f"Слов: {len(ws)}, уникальных: {len(set(ws))}")
    print(f"Предложений: {len(ss)}, в среднем {len(ws) / len(ss):.1f} слова")
    kinds = {".": 0, "!": 0, "?": 0}
    for s in ss:
        kinds[s[-1]] += 1
    print(f"Повествовательных {kinds['.']}, восклицательных {kinds['!']}, вопросительных {kinds['?']}")


def print_top(text):
    print("Частые слова:")
    for w, c in top(frequencies(words(text)), 5):
        print(f"  {w:<8} {'*' * c} {c}")


def print_letters(text):
    counts = letters(text)
    total = sum(counts.values())
    vowels = sum(c for ch, c in counts.items() if ch in VOWELS)
    print(f"Букв: {total}, гласных {vowels} ({vowels * 100 / total:.1f}%)")
    best = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))[:3]
    print("Чаще всего: " + ", ".join(f"«{ch}» {c}" for ch, c in best))


def print_longest(text):
    ws = sorted(set(words(text)), key=lambda w: (-len(w), w))
    print("Самые длинные слова: " + ", ".join(ws[:3]))
    syl = sorted(set(words(text)), key=lambda w: (-syllables(w), w))[0]
    print(f"Больше всего слогов: {syl} ({syllables(syl)})")


def print_palindromes(text):
    print("Палиндромы:")
    found = [w for w in sorted(set(words(text))) if is_palindrome(w)]
    print("  слова: " + (", ".join(found) if found else "нет"))
    phrases = [s for s in sentences(text) if is_palindrome(s)]
    for s in phrases:
        print(f"  фраза: {s}")


def main():
    print("СТАТИСТИКА ТЕКСТА")
    print()
    print_basic(TEXT)
    print()
    print_top(TEXT)
    print()
    print_letters(TEXT)
    print()
    print_longest(TEXT)
    print()
    print_palindromes(TEXT)


if __name__ == "__main__":
    main()
