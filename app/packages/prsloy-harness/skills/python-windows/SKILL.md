---
name: python-windows
description: "Python-скрипт на Windows: venv в папке проекта, python (не py), пути с кириллицей и пробелами, UTF-8 в файлах и консоли, ярлык .bat для запуска двойным кликом."
---

# Python-скрипт на Windows

## Interpreter

- In this app `python` and `python3` already point to the bundled Python 3.12. Use `python`. Do not use `py`
  (the launcher comes only with the python.org installer and may be missing) and never send the user to
  python.org to install anything.
- One venv per project, inside it: `python -m venv .venv`. No need to "activate" it — call its interpreter
  directly: `.venv/Scripts/python -m pip install …`, `.venv/Scripts/python script.py` (Linux/macOS: `.venv/bin/`).
- Pin what you installed in `requirements.txt` (`.venv/Scripts/python -m pip freeze > requirements.txt` or the
  few top-level packages by hand).

## Paths

- Project folders often have Cyrillic and spaces («Мои документы/Отчёт 2026»). In bash always quote paths:
  `"…/Отчёт 2026/data.csv"`. In Python use `pathlib.Path`, never glue strings with `\`.
- Files next to the script: `BASE = Path(__file__).resolve().parent`, then `BASE / "data.csv"` — works no matter
  from which folder the script is started (double click starts it in its own folder, a shortcut may not).

## Text and encodings

- `open()` without `encoding` uses the Windows code page (cp1251), not UTF-8. Always pass `encoding="utf-8"`
  when you write text, and read with the encoding the file really has (CSV from Excel: see the excel-csv skill).
- Console output with Cyrillic or emoji can fail with `UnicodeEncodeError`. Run with `python -X utf8 script.py`
  (UTF-8 mode) or set `PYTHONUTF8=1`.

## Double-click launcher

If the user wants to start the script themselves, add `Запустить.bat` next to it:

```bat
@echo off
chcp 65001 > nul
"%~dp0.venv\Scripts\python.exe" -X utf8 "%~dp0script.py"
pause
```

`%~dp0` is the folder of the .bat (works with spaces in quotes); `pause` keeps the window open so the user can
read the result or the error.

## Sources

- Python on Windows (launcher, UTF-8 mode, venv): https://docs.python.org/3/using/windows.html
- venv: https://docs.python.org/3/library/venv.html
- UTF-8 mode: https://docs.python.org/3/library/os.html#utf8-mode
- pathlib: https://docs.python.org/3/library/pathlib.html
