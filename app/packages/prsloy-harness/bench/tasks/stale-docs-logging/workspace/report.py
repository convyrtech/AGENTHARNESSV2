import csv
import logging

logging.basicConfig(level=logging.INFO, format="%(message)s")
log = logging.getLogger("report")


def main():
    with open("sales.csv", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    for row in rows:
        log.info("%s: %s ₽", row["day"], row["amount"])


if __name__ == "__main__":
    main()
