from bill import per_person


def test_no_tip():
    assert per_person(3000, 3) == 1000


def test_tip():
    assert per_person(3000, 3, 10) == 1100


def test_four_people():
    assert per_person(1000, 4, 0) == 250


def test_four_people_tip():
    assert per_person(2000, 4, 10) == 500
