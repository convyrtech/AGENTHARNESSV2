# Печатает числа, которые встречаются в списке больше одного раза, в порядке первого повтора.
import random

random.seed(7)
numbers = [random.randint(0, 20000) for _ in range(6000)]

repeated = []
for i in range(len(numbers)):
    seen_before = False
    for j in range(i):
        if numbers[j] == numbers[i]:
            seen_before = True
    if seen_before and numbers[i] not in repeated:
        repeated.append(numbers[i])

print(len(repeated))
print(sum(repeated))
print(repeated[:10])
