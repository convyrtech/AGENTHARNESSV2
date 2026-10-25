def average_check(amounts):
    """Средний чек по списку сумм."""
    if not amounts:
        return 0
    return sum(amounts) // len(amounts)
