"""Расписание встреч на день: пересечения, свободные окна, загрузка людей."""

DAY_START = "09:00"
DAY_END = "19:00"

MEETINGS = [
    ("Планёрка", "09:30-10:00", ["Оля", "Пётр", "Сева", "Таня"]),
    ("Созвон с клиентом", "10:15-11:00", ["Оля", "Сева"]),
    ("Ревью дизайна", "10:45-11:30", ["Таня", "Пётр"]),
    ("Обед с партнёром", "13:00-14:15", ["Оля"]),
    ("Собеседование", "14:00-15:00", ["Пётр", "Таня"]),
    ("Разбор задач", "15:30-16:30", ["Сева", "Таня", "Пётр"]),
    ("Звонок поставщику", "16:00-16:20", ["Оля"]),
    ("Итоги дня", "18:00-18:30", ["Оля", "Пётр", "Сева", "Таня"]),
]


def to_min(hhmm):
    h, m = hhmm.split(":")
    return int(h) * 60 + int(m)


def to_hhmm(minutes):
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


def parse(span):
    a, b = span.split("-")
    return to_min(a), to_min(b)


def duration_text(minutes):
    h, m = divmod(minutes, 60)
    if h and m:
        return f"{h} ч {m} мин"
    if h:
        return f"{h} ч"
    return f"{m} мин"


def people(meetings):
    names = []
    for _, _, who in meetings:
        for name in who:
            if name not in names:
                names.append(name)
    return sorted(names)


def overlaps(meetings):
    out = []
    for i in range(len(meetings)):
        for j in range(i + 1, len(meetings)):
            a1, b1 = parse(meetings[i][1])
            a2, b2 = parse(meetings[j][1])
            start, end = max(a1, a2), min(b1, b2)
            if start < end:
                common = sorted(set(meetings[i][2]) & set(meetings[j][2]))
                out.append((meetings[i][0], meetings[j][0], end - start, common))
    return out


def busy_intervals(meetings, name):
    spans = sorted(parse(span) for _, span, who in meetings if name in who)
    merged = []
    for a, b in spans:
        if merged and a <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], b))
        else:
            merged.append((a, b))
    return merged


def free_windows(busy, min_len=30):
    start, end = to_min(DAY_START), to_min(DAY_END)
    out = []
    cur = start
    for a, b in busy:
        if a - cur >= min_len:
            out.append((cur, a))
        cur = max(cur, b)
    if end - cur >= min_len:
        out.append((cur, end))
    return out


def common_free(meetings, min_len=30):
    everyone = []
    for _, span, _ in meetings:
        everyone.append(parse(span))
    everyone.sort()
    merged = []
    for a, b in everyone:
        if merged and a <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], b))
        else:
            merged.append((a, b))
    return free_windows(merged, min_len)


def print_list(meetings):
    print("Встречи:")
    for title, span, who in sorted(meetings, key=lambda m: parse(m[1])):
        a, b = parse(span)
        print(f"  {to_hhmm(a)}–{to_hhmm(b)}  {title:<20} {duration_text(b - a):>10}  ({len(who)} чел.)")


def print_overlaps(meetings):
    print("Пересечения:")
    found = overlaps(meetings)
    if not found:
        print("  нет")
    for m1, m2, minutes, common in found:
        clash = f", конфликт у: {', '.join(common)}" if common else ""
        print(f"  «{m1}» и «{m2}» — {minutes} мин{clash}")


def print_people(meetings):
    print("Загрузка:")
    day = to_min(DAY_END) - to_min(DAY_START)
    for name in people(meetings):
        busy = busy_intervals(meetings, name)
        total = sum(b - a for a, b in busy)
        share = total * 100 / day
        windows = free_windows(busy, 60)
        longest = max((b - a for a, b in windows), default=0)
        print(f"  {name:<5} занят {duration_text(total):>10} ({share:4.1f}%), окон от часа: {len(windows)}, самое длинное {duration_text(longest)}")


def print_common(meetings):
    print("Окна, свободные у всех (от 30 мин):")
    for a, b in common_free(meetings):
        print(f"  {to_hhmm(a)}–{to_hhmm(b)} ({duration_text(b - a)})")


def main():
    print(f"РАСПИСАНИЕ НА ДЕНЬ ({DAY_START}–{DAY_END})")
    print()
    print_list(MEETINGS)
    print()
    print_overlaps(MEETINGS)
    print()
    print_people(MEETINGS)
    print()
    print_common(MEETINGS)


if __name__ == "__main__":
    main()
