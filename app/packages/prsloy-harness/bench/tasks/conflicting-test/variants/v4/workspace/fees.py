def late_fee(days):
    """Пеня за просрочку."""
    if days < 0:
        return 0
    return days * 10
