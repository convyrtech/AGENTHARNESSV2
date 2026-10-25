"""Read a CSV or Excel file the way Russian Excel writes it. Usage: read_table(path) -> pandas.DataFrame (all text)."""

from pathlib import Path

import pandas as pd


def read_table(path: str | Path) -> pd.DataFrame:
    path = Path(path)
    if path.suffix.lower() in (".xlsx", ".xlsm", ".xls"):
        return pd.read_excel(path, sheet_name=0, dtype=str)
    # «CSV UTF-8» из Excel — с BOM (utf-8-sig); обычный «CSV» русского Excel — cp1251.
    for encoding in ("utf-8-sig", "cp1251"):
        try:
            header = path.open(encoding=encoding).readline()
            # Разделитель — по строке заголовков: угадывание по данным путает «;» с запятой в «1,5».
            # Без разделителя в заголовке — один столбец: запятую в «1,5» не режем.
            sep = ";" if ";" in header else "\t" if "\t" in header else "," if "," in header else ";"
            return pd.read_csv(path, encoding=encoding, sep=sep, dtype=str)
        except UnicodeDecodeError:
            continue
    raise ValueError(f"Не удалось прочитать {path}: неизвестная кодировка")


def to_number(column: pd.Series) -> pd.Series:
    """«1 250,50» (пробел или неразрывный пробел, запятая) -> 1250.5."""
    cleaned = column.str.replace(r"[\s\u00a0]", "", regex=True).str.replace(",", ".", regex=False)
    return pd.to_numeric(cleaned, errors="coerce")


if __name__ == "__main__":
    import sys

    df = read_table(sys.argv[1])
    print(len(df), "строк")
    print(df.head())
