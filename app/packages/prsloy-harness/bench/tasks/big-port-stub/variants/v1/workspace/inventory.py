"""Отчёт по складу: остатки, стоимость, что пора заказать."""

ITEMS = [
    {"sku": "A-101", "name": "Кружка белая", "category": "посуда", "qty": 42, "min": 20, "price": 350, "supplier": "Керамика+"},
    {"sku": "A-102", "name": "Кружка чёрная", "category": "посуда", "qty": 8, "min": 20, "price": 390, "supplier": "Керамика+"},
    {"sku": "A-205", "name": "Тарелка глубокая", "category": "посуда", "qty": 15, "min": 10, "price": 420, "supplier": "Фарфор Юг"},
    {"sku": "B-310", "name": "Полотенце льняное", "category": "текстиль", "qty": 3, "min": 12, "price": 690, "supplier": "Лён и Ко"},
    {"sku": "B-311", "name": "Скатерть", "category": "текстиль", "qty": 9, "min": 5, "price": 1890, "supplier": "Лён и Ко"},
    {"sku": "C-020", "name": "Свеча ароматная", "category": "декор", "qty": 64, "min": 30, "price": 270, "supplier": "Воск"},
    {"sku": "C-021", "name": "Ваза стеклянная", "category": "декор", "qty": 0, "min": 4, "price": 2450, "supplier": "Стекло"},
    {"sku": "C-033", "name": "Рамка 10x15", "category": "декор", "qty": 27, "min": 15, "price": 310, "supplier": "Стекло"},
    {"sku": "D-400", "name": "Нож кухонный", "category": "кухня", "qty": 11, "min": 8, "price": 1290, "supplier": "Сталь"},
    {"sku": "D-401", "name": "Доска разделочная", "category": "кухня", "qty": 6, "min": 10, "price": 760, "supplier": "Дерево"},
]

PACK = {"посуда": 12, "текстиль": 6, "декор": 10, "кухня": 4}


def money(kopecks_free):
    """Целые рубли с пробелами между тысячами: 12345 -> '12 345 ₽'."""
    s = str(int(kopecks_free))
    groups = []
    while len(s) > 3:
        groups.insert(0, s[-3:])
        s = s[:-3]
    groups.insert(0, s)
    return " ".join(groups) + " ₽"


def pad(text, width, right=False):
    text = str(text)
    if len(text) >= width:
        return text[:width]
    return text.rjust(width) if right else text.ljust(width)


def stock_value(item):
    return item["qty"] * item["price"]


def status(item):
    if item["qty"] == 0:
        return "нет"
    if item["qty"] < item["min"]:
        return "мало"
    return "ок"


def reorder_qty(item):
    """Сколько заказать: до двойного минимума, кратно упаковке категории."""
    need = item["min"] * 2 - item["qty"]
    if need <= 0:
        return 0
    pack = PACK[item["category"]]
    packs = (need + pack - 1) // pack
    return packs * pack


def by_category(items):
    out = {}
    for item in items:
        cat = item["category"]
        if cat not in out:
            out[cat] = {"count": 0, "qty": 0, "value": 0}
        out[cat]["count"] += 1
        out[cat]["qty"] += item["qty"]
        out[cat]["value"] += stock_value(item)
    return out


def by_supplier(items):
    out = {}
    for item in items:
        sup = item["supplier"]
        out[sup] = out.get(sup, 0) + reorder_qty(item) * item["price"]
    return out


def print_table(items):
    print(pad("Артикул", 7) + " | " + pad("Товар", 18) + " | " + pad("Ост.", 4, True) + " | " + pad("Статус", 6) + " | " + pad("Стоимость", 12, True))
    print("-" * 59)
    for item in sorted(items, key=lambda i: (i["category"], i["sku"])):
        print(pad(item["sku"], 7) + " | " + pad(item["name"], 18) + " | " + pad(item["qty"], 4, True) + " | " + pad(status(item), 6) + " | " + pad(money(stock_value(item)), 12, True))


def print_categories(items):
    print("По категориям:")
    cats = by_category(items)
    for cat in sorted(cats, key=lambda c: -cats[c]["value"]):
        c = cats[cat]
        share = c["value"] * 100 / sum(stock_value(i) for i in items)
        print(f"  {cat}: позиций {c['count']}, штук {c['qty']}, на {money(c['value'])} ({share:.1f}%)")


def print_reorder(items):
    print("Пора заказать:")
    total = 0
    rows = [i for i in items if reorder_qty(i) > 0]
    rows.sort(key=lambda i: (status(i) != "нет", -reorder_qty(i) * i["price"], i["sku"]))
    for item in rows:
        q = reorder_qty(item)
        cost = q * item["price"]
        total += cost
        mark = "!" if status(item) == "нет" else " "
        print(f" {mark} {item['sku']} {item['name']}: {q} шт. на {money(cost)}")
    print(f"  Всего к заказу: {money(total)}")


def print_suppliers(items):
    print("По поставщикам:")
    sup = by_supplier(items)
    for name in sorted(sup):
        if sup[name] > 0:
            print(f"  {name}: {money(sup[name])}")


def print_summary(items):
    total_value = sum(stock_value(i) for i in items)
    empty = [i["sku"] for i in items if status(i) == "нет"]
    low = [i["sku"] for i in items if status(i) == "мало"]
    dearest = max(items, key=lambda i: i["price"])
    print("Итого:")
    print(f"  позиций {len(items)}, штук {sum(i['qty'] for i in items)}, стоимость склада {money(total_value)}")
    print(f"  закончились: {', '.join(empty) if empty else '—'}")
    print(f"  мало: {', '.join(low) if low else '—'}")
    print(f"  самый дорогой товар: {dearest['name']} ({money(dearest['price'])})")


def main():
    print("ОТЧЁТ ПО СКЛАДУ")
    print()
    print_table(ITEMS)
    print()
    print_categories(ITEMS)
    print()
    print_reorder(ITEMS)
    print()
    print_suppliers(ITEMS)
    print()
    print_summary(ITEMS)


if __name__ == "__main__":
    main()
