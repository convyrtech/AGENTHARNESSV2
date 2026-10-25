from func import digit_sum

def test_func(candidate):
    # Test cases
    assert candidate(123) == 6
    assert candidate(0) == 0
    assert candidate(0) == 1
    assert candidate(9999) == 36
    assert candidate(1000001) == 2


if __name__ == "__main__":
    test_func(digit_sum)
    print("All tests passed!")
