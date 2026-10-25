"""Счёт клиенту: позиции, скидки за объём, промокод, НДС, итог прописью до рублей."""

CLIENT = {"name": "ООО «Ромашка»", "inn": "7701234567", "loyal": True}

LINES = [
    {"code": "P-01", "title": "Бумага А4, пачка", "unit": "шт", "qty": 40, "price_kop": 41900},
    {"code": "P-07", "title": "Ручка гелевая", "unit": "шт", "qty": 120, "price_kop": 6450},
    {"code": "P-12", "title": "Папка-регистратор", "unit": "шт", "qty": 18, "price_kop": 23900},
    {"code": "S-03", "title": "Доставка по городу", "unit": "усл", "qty": 1, "price_kop": 90000},
    {"code": "P-20", "title": "Картридж для принтера", "unit": "шт", "qty": 3, "price_kop": 489000},
]

VAT_PERCENT = 20
PROMO = {"code": "OFFICE7", "percent": 7, "min_total_kop": 5000000}


def rub(kop):
    """Копейки -> '12 345,67 ₽'."""
    sign = "-" if kop < 0 else ""
    kop = abs(kop)
    rubles, rest = divmod(kop, 100)
    s = str(rubles)
    parts = []
    while len(s) > 3:
        parts.insert(0, s[-3:])
        s = s[:-3]
    parts.insert(0, s)
    return f"{sign}{' '.join(parts)},{rest:02d} ₽"


def volume_discount(line):
    """Скидка за объём на товары (не на услуги): от 100 шт — 10%, от 30 шт — 5%."""
    if line["unit"] != "шт":
        return 0
    if line["qty"] >= 100:
        return 10
    if line["qty"] >= 30:
        return 5
    return 0


def line_total(line):
    gross = line["qty"] * line["price_kop"]
    disc = gross * volume_discount(line) // 100
    return gross, disc, gross - disc


def promo_applies(subtotal):
    return subtotal >= PROMO["min_total_kop"]


def loyalty_bonus(subtotal):
    """Постоянным клиентам — 1% от суммы после скидок, но не больше 2 000 ₽."""
    if not CLIENT["loyal"]:
        return 0
    return min(subtotal // 100, 200000)


def vat_part(total_with_vat):
    """НДС внутри суммы, до копейки вниз."""
    return total_with_vat * VAT_PERCENT // (100 + VAT_PERCENT)


def print_header():
    print(f"СЧЁТ для {CLIENT['name']}, ИНН {CLIENT['inn']}")
    print("=" * 64)


def print_lines():
    print(f"{'Код':<5} {'Наименование':<24} {'Кол.':>5} {'Цена':>13} {'Сумма':>14}")
    rows = []
    for line in LINES:
        gross, disc, net = line_total(line)
        rows.append(net)
        print(f"{line['code']:<5} {line['title']:<24} {line['qty']:>5} {rub(line['price_kop']):>13} {rub(gross):>14}")
        if disc:
            print(f"{'':<5} {'  скидка ' + str(volume_discount(line)) + '%':<24} {'':>5} {'':>13} {rub(-disc):>14}")
    return sum(rows)


def print_totals(subtotal):
    print("-" * 64)
    print(f"{'Сумма после скидок за объём:':<46}{rub(subtotal):>18}")
    total = subtotal
    if promo_applies(subtotal):
        promo = subtotal * PROMO["percent"] // 100
        total -= promo
        print(f"{'Промокод ' + PROMO['code'] + ' (' + str(PROMO['percent']) + '%):':<46}{rub(-promo):>18}")
    else:
        need = PROMO["min_total_kop"] - subtotal
        print(f"Промокод {PROMO['code']} не применён: не хватает {rub(need)}")
    bonus = loyalty_bonus(total)
    if bonus:
        total -= bonus
        print(f"{'Скидка постоянного клиента (1%):':<46}{rub(-bonus):>18}")
    print(f"{'ИТОГО к оплате:':<46}{rub(total):>18}")
    print(f"{'в т. ч. НДС ' + str(VAT_PERCENT) + '%:':<46}{rub(vat_part(total)):>18}")
    return total


def words_thousands(n):
    ones = ["", "одна", "две", "три", "четыре", "пять", "шесть", "семь", "восемь", "девять"]
    if n % 10 == 1 and n % 100 != 11:
        form = "тысяча"
    elif 2 <= n % 10 <= 4 and not 12 <= n % 100 <= 14:
        form = "тысячи"
    else:
        form = "тысяч"
    return form, ones


def summary_line(total):
    rubles = total // 100
    thousands = rubles // 1000
    form, _ = words_thousands(thousands)
    print(f"Сумма: {thousands} {form} {rubles % 1000} руб. {total % 100:02d} коп.")


def print_stats():
    goods = [l for l in LINES if l["unit"] == "шт"]
    pieces = sum(l["qty"] for l in goods)
    biggest = max(LINES, key=lambda l: line_total(l)[2])
    saved = sum(line_total(l)[1] for l in LINES)
    print(f"Позиций {len(LINES)}, товаров {pieces} шт.")
    print(f"Самая крупная позиция: {biggest['title']} ({rub(line_total(biggest)[2])})")
    print(f"Сэкономлено на скидках за объём: {rub(saved)}")


def main():
    print_header()
    subtotal = print_lines()
    total = print_totals(subtotal)
    print()
    summary_line(total)
    print_stats()


if __name__ == "__main__":
    main()
