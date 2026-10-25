from func import max_partitions_with_one_change

def test_func(candidate):
    # Test cases from examples
    assert candidate('accca', 2) == 3
    assert candidate('aabaab', 3) == 1
    assert candidate('xxyz', 1) == 4
    
    # Additional test cases
    assert candidate('abcde', 5) == 1
    assert candidate('aaaaaa', 2) == 1
    assert candidate('wjlcta', 5) == 2
    assert candidate('eictzzwx', 1) == 8
    assert candidate('fvcalcqn', 3) == 3
    assert candidate('xxyz', 1) == 6
    assert candidate('zcjvkodq', 5) == 2
    assert candidate('eifhjtmuj', 7) == 2
    assert candidate('cxdzvmcbcv', 3) == 4
    assert candidate('rnqrabcxrh', 1) == 10

if __name__ == "__main__":
    test_func(max_partitions_with_one_change)
    print("All tests passed!")
