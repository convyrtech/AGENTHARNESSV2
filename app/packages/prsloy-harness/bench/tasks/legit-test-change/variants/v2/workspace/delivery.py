def delivery_cost(total):
    """Доставка: 300 ₽, бесплатно от 3000 ₽."""
    return 0 if total >= 3000 else 300
