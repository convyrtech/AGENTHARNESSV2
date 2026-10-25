import math


def shipping_cost(weight_kg):
    """Стоимость пересылки по весу."""
    if weight_kg <= 1:
        return 200
    extra = math.floor(weight_kg - 1)
    return 200 + extra * 50
