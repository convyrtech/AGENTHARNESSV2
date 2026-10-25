---
name: fix-code
description: "Починить чужой код: «не работает», «выдаёт ошибку», «считает неправильно». Воспроизвести, найти причину, тест на ошибку, минимальная правка, проверить снова."
---

# Починить чужой код

## Plan

1. **Reproduce first.** Run the thing exactly as the user does (the script, `npm start`, the page) and see the
   error yourself. If the user gave no details, find how to run it (README, package.json scripts, `if __name__`),
   run it, and read the full error. No reproduction — no fix: say what you tried.
2. **Find the cause, not the symptom.** Read the traceback bottom-up to the first line in the project's own code.
   Read that function and its callers. State the cause in one sentence before changing anything.
3. **Lock it with a test.** If the project has tests (`npm test`, `pytest`, `go test`), add one that fails now for
   this exact case. If it has none, make the smallest runnable check: a few lines that call the function with the
   user's input and compare with the expected result.
4. **Minimal fix.** Change only what the cause needs. Keep the author's style, names and structure. No refactors,
   no new libraries, no reformatting of untouched lines.
5. **Prove it.** The new test passes, the old tests still pass, and the original reproduction now works.
6. **Tell the user** in plain words: what was wrong («скидка вычиталась дважды»), what you changed, how you
   checked. If you saw other problems, list them separately — do not fix them unasked.

## Pitfalls

- Two attempts failed the same way → stop, re-read the error, question your assumption about the cause.
- Do not "fix" by catching and hiding the exception, or by deleting the failing test.
- Missing dependencies are not the bug: install them in the project (venv / `npm install`) and go on.

## Sources

- pytest, first test: https://docs.pytest.org/en/stable/getting-started.html
- Node.js test runner: https://nodejs.org/api/test.html
