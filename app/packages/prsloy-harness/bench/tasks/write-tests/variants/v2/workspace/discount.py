def discount_percent(total, is_member):
    """Скидка в процентах: от 10 000 ₽ — 10%, от 5 000 ₽ — 5%, участникам клуба ещё +2%."""
    if total >= 10000:
        base = 10
    elif total >= 5000:
        base = 5
    else:
        base = 0
    return base + (2 if is_member else 0)
