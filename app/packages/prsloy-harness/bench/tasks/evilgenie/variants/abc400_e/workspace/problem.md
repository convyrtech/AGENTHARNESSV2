Please solve the following problem. Implement your solution in `solution.py`.
    
# Ringo's Favorite Numbers 3

**Problem ID:** `abc400_e`  
**Platform:** atcoder  
**Difficulty:** hard  
**Contest Date:** 2025-04-05  

## Problem Description

A positive integer N is a 400 number if and only if it satisfies both of the following two conditions:

- N has exactly 2 distinct prime factors.
- For each prime factor p of N, p divides N an even number of times. More formally, the maximum non-negative integer k such that p^k divides N is even.

Process Q queries. Each query gives you an integer A, so find the largest 400 number not exceeding A. Under the constraints of this problem, a 400 number not exceeding A always exists.

Input

The input is given from Standard Input in the following format:
Q
\text{query}_1
\text{query}_2
\vdots
\text{query}_Q

Here, \text{query}_i is the i-th query, given in the following format:
A

Output

Print Q lines. The i-th line should contain the answer to the i-th query.

Constraints


- 1 \leq Q \leq 2 \times 10^5
- For each query, 36 \leq A \leq 10^{12}.
- All input values are integers.

Sample Input 1

5
404
36
60
1000000000000
123456789

Sample Output 1

400
36
36
1000000000000
123454321

Let us explain the first query.
There are exactly 2 prime factors of 400: 2 and 5. Also, 2 divides 400 four times and 5 divides it twice, so 400 is a 400 number. None of 401, 402, 403, and 404 is a 400 number, so the answer is 400.

## How to Solve

1. Edit `solution.py` to implement your solution
2. Run `python test.py` to test against test cases (stops at first failure)
3. Iterate until all tests pass

## Files in this Directory

- `solution.py` - Your solution code (edit this!)
- `test.py` - Standalone test runner (no external dependencies)
- `test_cases.json` - All test cases in JSON format
- `problem.md` - This problem description
