---
name: excel-csv
description: "Таблицы Excel и CSV: свести продажи, посчитать суммы по месяцам, почистить выгрузку. pandas + openpyxl; CSV из русского Excel (cp1251, «;», запятая, неразрывный пробел)."
---

# Excel и CSV

Tools: **pandas** + **openpyxl** (`.venv/Scripts/python -m pip install pandas openpyxl` in a project venv).
`read_table.py` next to this file reads a CSV or Excel file the way Russian Excel writes it — copy it.

## Reading

- `.xlsx`: `pd.read_excel(path, sheet_name=0)` (openpyxl). List sheets with `pd.ExcelFile(path).sheet_names`.
- CSV from Russian Excel is usually **cp1251**, separated by **`;`**, decimal **comma**, and thousands split by a
  **non-breaking space** (U+00A0), which `thousands=" "` does not match. «CSV UTF-8» from Excel has a BOM: use
  `utf-8-sig`. Do not guess: try `utf-8-sig`, then `cp1251`, and take the separator from the header line —
  pandas' sniffing (`sep=None`) mistakes the comma in `1,5` for the separator. `read_table.py` does both.
- Read money columns as text first, then clean: drop spaces and U+00A0, comma → dot, `pd.to_numeric`.
- Dates like `01.03.2026` are day-first: `pd.to_datetime(col, format="%d.%m.%Y")` (or `dayfirst=True`). Never
  let `01.03` become January 3.

## Working

- Look before you compute: print `df.head()`, `df.dtypes`, row count. Say what you found in plain words
  («в файле 1 240 строк, с января по март»).
- Sums by month: `df.groupby(df["Дата"].dt.to_period("M"))["Сумма"].sum()`.
- Never overwrite the user's file. Write a new one next to it.

## Writing

- For the user: `df.to_excel("итог.xlsx", index=False, sheet_name="Итог")` — opens in Excel with Cyrillic and
  numbers as numbers.
- If they need CSV for Russian Excel: `df.to_csv("итог.csv", sep=";", decimal=",", index=False, encoding="utf-8-sig")`.
- Check: read the result back and compare totals with the source (sum before = sum after).

## Sources

- `read_csv` (encoding, sep, decimal, thousands): https://pandas.pydata.org/docs/reference/api/pandas.read_csv.html
- `read_excel`: https://pandas.pydata.org/docs/reference/api/pandas.read_excel.html
- `to_excel`: https://pandas.pydata.org/docs/reference/api/pandas.DataFrame.to_excel.html
- `to_datetime`: https://pandas.pydata.org/docs/reference/api/pandas.to_datetime.html
- openpyxl: https://openpyxl.readthedocs.io/en/stable/
- Python codecs (cp1251, utf-8-sig): https://docs.python.org/3/library/codecs.html#standard-encodings
