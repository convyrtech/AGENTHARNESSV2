from func import count_vowels

def test_func(candidate):
    # Test cases
    assert candidate('hello') == 2
    assert candidate('SKY') == 0
    assert candidate('AEIOU') == 5
    assert candidate('Programming') == 4
    assert candidate('') == 0


if __name__ == "__main__":
    test_func(count_vowels)
    print("All tests passed!")
