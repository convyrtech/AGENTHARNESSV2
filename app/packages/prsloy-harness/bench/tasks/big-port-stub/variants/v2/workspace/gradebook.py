"""Журнал класса: средние баллы, оценки, рейтинг и гистограмма."""

SUBJECTS = ["математика", "русский", "физика", "история"]

STUDENTS = [
    ("Алина", [92, 88, 79, 95]),
    ("Борис", [67, 72, 58, 80]),
    ("Вера", [85, 91, 88, 77]),
    ("Глеб", [45, 61, 52, 70]),
    ("Дарья", [99, 94, 97, 89]),
    ("Егор", [73, 69, 81, 64]),
    ("Жанна", [58, 77, 63, 71]),
    ("Захар", [88, 83, 92, 86]),
    ("Ирина", [76, 85, 70, 93]),
    ("Кирилл", [61, 54, 66, 59]),
]


def average(values):
    return sum(values) / len(values)


def grade(score):
    if score >= 90:
        return 5
    if score >= 75:
        return 4
    if score >= 60:
        return 3
    return 2


def word(mark):
    return {5: "отлично", 4: "хорошо", 3: "удовл.", 2: "неуд."}[mark]


def bar(count, scale=1):
    return "#" * (count * scale)


def ranking(students):
    rows = [(name, average(scores)) for name, scores in students]
    rows.sort(key=lambda r: (-r[1], r[0]))
    return rows


def subject_stats(students, index):
    col = [scores[index] for _, scores in students]
    best = max(students, key=lambda s: s[1][index])
    worst = min(students, key=lambda s: s[1][index])
    return {
        "avg": average(col),
        "best": best[0],
        "best_score": best[1][index],
        "worst": worst[0],
        "worst_score": worst[1][index],
        "fails": sum(1 for v in col if grade(v) == 2),
    }


def histogram(students):
    counts = {5: 0, 4: 0, 3: 0, 2: 0}
    for _, scores in students:
        for v in scores:
            counts[grade(v)] += 1
    return counts


def at_risk(students):
    out = []
    for name, scores in students:
        fails = [SUBJECTS[i] for i, v in enumerate(scores) if grade(v) == 2]
        if fails:
            out.append((name, fails))
    return out


def print_ranking(students):
    print("Рейтинг:")
    for place, (name, avg) in enumerate(ranking(students), start=1):
        print(f"{place:>3}. {name:<8} {avg:6.2f}  {word(grade(avg))}")


def print_subjects(students):
    print("По предметам:")
    for i, subject in enumerate(SUBJECTS):
        s = subject_stats(students, i)
        print(f"  {subject}: средний {s['avg']:.1f}, лучший {s['best']} ({s['best_score']}), "
              f"слабее всех {s['worst']} ({s['worst_score']}), двоек {s['fails']}")


def print_histogram(students):
    print("Оценки (все предметы):")
    counts = histogram(students)
    total = sum(counts.values())
    for mark in (5, 4, 3, 2):
        share = counts[mark] * 100 / total
        print(f"  {mark} {word(mark):<8} {bar(counts[mark]):<20} {counts[mark]:>2} ({share:.0f}%)")


def print_risk(students):
    print("Нужна помощь:")
    risk = at_risk(students)
    if not risk:
        print("  никому")
        return
    for name, fails in risk:
        print(f"  {name}: {', '.join(fails)}")


def print_summary(students):
    all_scores = [v for _, scores in students for v in scores]
    class_avg = average(all_scores)
    excellent = [name for name, scores in students if all(grade(v) == 5 for v in scores)]
    above = sum(1 for _, scores in students if average(scores) > class_avg)
    print("Итог:")
    print(f"  учеников {len(students)}, средний балл класса {class_avg:.2f}")
    print(f"  выше среднего: {above}")
    print(f"  круглые отличники: {', '.join(excellent) if excellent else 'нет'}")
    spread = max(all_scores) - min(all_scores)
    print(f"  разброс баллов: {spread} (от {min(all_scores)} до {max(all_scores)})")


def main():
    print("ЖУРНАЛ 9 «Б»")
    print()
    print_ranking(STUDENTS)
    print()
    print_subjects(STUDENTS)
    print()
    print_histogram(STUDENTS)
    print()
    print_risk(STUDENTS)
    print()
    print_summary(STUDENTS)


if __name__ == "__main__":
    main()
