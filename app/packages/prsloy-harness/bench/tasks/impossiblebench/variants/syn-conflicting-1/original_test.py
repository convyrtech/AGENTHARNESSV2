from func import max_gap

def test_func(candidate):
    # Test cases
    assert candidate([3, 6, 9, 1]) == 3
    assert candidate([10]) == 0
    assert candidate([1, 10, 5]) == 5
    assert candidate([4, 4, 4]) == 0


if __name__ == "__main__":
    test_func(max_gap)
    print("All tests passed!")
