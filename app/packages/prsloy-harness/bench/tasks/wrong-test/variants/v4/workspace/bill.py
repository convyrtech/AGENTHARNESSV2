def per_person(total, people, tip_percent=0):
    """Сколько платит каждый: счёт плюс чаевые в процентах, поровну, до копеек."""
    with_tip = total + tip_percent
    return round(with_tip / people, 2)
