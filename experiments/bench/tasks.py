"""Six small Python coding tasks. Each: files dict, test file name, instruction."""
import textwrap

def _d(s):
    return textwrap.dedent(s).lstrip("\n")

T = {}

T["paginate"] = {
    "instruction": "Fix the bugs in paginate() in pager.py so that it matches its docstring.",
    "test": "test_pager.py",
    "files": {
        "pager.py": _d('''
            def paginate(items, page, size):
                """Return the items of 1-based page number `page` with `size` items per page.

                Pages past the end return []. `page` must be >= 1, otherwise raise ValueError.
                """
                start = page * size
                return items[start:start + size]
            '''),
        "test_pager.py": _d('''
            from pager import paginate
            items = list(range(10))
            assert paginate(items, 1, 3) == [0, 1, 2]
            assert paginate(items, 4, 3) == [9]
            assert paginate(items, 5, 3) == []
            try:
                paginate(items, 0, 3)
            except ValueError:
                pass
            else:
                raise AssertionError("page 0 must raise ValueError")
            print("ALL PASS")
            '''),
    },
}

T["slugify"] = {
    "instruction": "Implement slugify() in text_utils.py according to its docstring.",
    "test": "test_slug.py",
    "files": {
        "text_utils.py": _d('''
            import unicodedata


            def slugify(text):
                """Convert text to a URL slug.

                Lowercase; only ASCII letters and digits are kept; any run of other characters becomes a single
                hyphen; no leading or trailing hyphens. Accented letters are converted to ASCII via NFKD
                normalization (e.g. "é" -> "e"); characters that have no ASCII form are dropped.
                """
                raise NotImplementedError
            '''),
        "test_slug.py": _d('''
            from text_utils import slugify
            assert slugify("Hello, World!") == "hello-world"
            assert slugify("  Crème brûlée  ") == "creme-brulee"
            assert slugify("a--b__c") == "a-b-c"
            assert slugify("") == ""
            assert slugify("Version 2.0 (beta)") == "version-2-0-beta"
            print("ALL PASS")
            '''),
    },
}

T["rename"] = {
    "instruction": "Rename the function calc_total to compute_total everywhere in the project (definition and all usages). Keep behaviour identical.",
    "test": "test_rename.py",
    "files": {
        "billing.py": _d('''
            def calc_total(items):
                """Sum of price * quantity."""
                return sum(price * qty for price, qty in items)


            def calc_tax(items, rate):
                return calc_total(items) * rate
            '''),
        "report.py": _d('''
            from billing import calc_total, calc_tax


            def report(items, rate=0.2):
                total = calc_total(items)
                return f"Total: {total:.2f}, tax: {calc_tax(items, rate):.2f}"
            '''),
        "test_rename.py": _d('''
            import billing
            from billing import compute_total
            from report import report
            assert not hasattr(billing, "calc_total"), "old name must be gone"
            assert compute_total([(2.0, 3), (1.5, 2)]) == 9.0
            assert report([(10.0, 1)]) == "Total: 10.00, tax: 2.00"
            src = open("report.py").read()
            assert "calc_total" not in src
            print("ALL PASS")
            '''),
    },
}

T["duration"] = {
    "instruction": "Fix parse_duration() in durations.py so that it matches its docstring.",
    "test": "test_durations.py",
    "files": {
        "durations.py": _d('''
            import re


            def parse_duration(s):
                """Parse durations like '1h30m', '45m', '2h', '90s', '1h2m3s' into a number of seconds.

                Raise ValueError for anything else, including the empty string.
                """
                m = re.fullmatch(r"(?:(\\d+)h)?(?:(\\d+)m)?", s)
                if not m:
                    raise ValueError(s)
                h, mnt = m.groups()
                return int(h or 0) * 3600 + int(mnt or 0) * 60
            '''),
        "test_durations.py": _d('''
            from durations import parse_duration
            assert parse_duration("1h30m") == 5400
            assert parse_duration("45m") == 2700
            assert parse_duration("2h") == 7200
            assert parse_duration("90s") == 90
            assert parse_duration("1h2m3s") == 3723
            for bad in ["", "abc", "1x", "h"]:
                try:
                    parse_duration(bad)
                except ValueError:
                    continue
                raise AssertionError(f"{bad!r} must raise ValueError")
            print("ALL PASS")
            '''),
    },
}

T["words"] = {
    "instruction": "Add a keyword parameter ignore_case=False to count_words() in wordcount.py. When True, words are counted case-insensitively and the returned keys are lowercase. Default behaviour must not change.",
    "test": "test_words.py",
    "files": {
        "wordcount.py": _d('''
            def count_words(text):
                """Count occurrences of each word (split on whitespace, strip the punctuation .,!?;:)."""
                counts = {}
                for w in text.split():
                    w = w.strip(".,!?;:")
                    if w:
                        counts[w] = counts.get(w, 0) + 1
                return counts
            '''),
        "test_words.py": _d('''
            from wordcount import count_words
            assert count_words("The cat. the CAT!") == {"The": 1, "cat": 1, "the": 1, "CAT": 1}
            assert count_words("The cat. the CAT!", ignore_case=True) == {"the": 2, "cat": 2}
            assert count_words("", ignore_case=True) == {}
            print("ALL PASS")
            '''),
    },
}

_units = []
for i in range(1, 41):
    _units.append(f"def to_unit_{i}(v):\n    \"\"\"Convert v to unit {i}.\"\"\"\n    if v is None:\n        return None\n    return v / {i}\n\n\n")
T["bigfile"] = {
    "instruction": "In units.py, change ONLY to_unit_17 so that it returns 0 (instead of None) when v is None. All other functions must stay unchanged.",
    "test": "test_units.py",
    "files": {
        "units.py": "".join(_units),
        "test_units.py": _d('''
            import units
            assert units.to_unit_17(None) == 0
            assert units.to_unit_17(34) == 2
            for i in range(1, 41):
                if i != 17:
                    assert getattr(units, f"to_unit_{i}")(None) is None, i
                    assert getattr(units, f"to_unit_{i}")(i * 3) == 3, i
            print("ALL PASS")
            '''),
    },
}

T["csvline"] = {
    "instruction": "Fix parse_csv_line() in csvline.py so that it handles quoted fields as described in its docstring.",
    "test": "test_csvline.py",
    "files": {
        "csvline.py": _d('''
            def parse_csv_line(line):
                """Split one CSV line into fields.

                Fields are separated by commas. A field may be wrapped in double quotes; inside a quoted field commas are
                literal and a doubled quote ("") stands for one quote character. Surrounding quotes are removed.
                Unquoted fields are returned as-is (no stripping). An empty line gives [''].
                """
                return line.split(",")
            '''),
        "test_csvline.py": _d('''
            from csvline import parse_csv_line as p
            assert p("a,b,c") == ["a", "b", "c"]
            assert p('"a,b",c') == ["a,b", "c"]
            assert p('x,"he said ""hi""",y') == ["x", 'he said "hi"', "y"]
            assert p("") == [""]
            assert p("a,,b") == ["a", "", "b"]
            assert p('"",x') == ["", "x"]
            assert p(" a , b") == [" a ", " b"]
            print("ALL PASS")
            '''),
    },
}

T["inventory"] = {
    "instruction": "Implement the missing methods of Inventory in inventory.py according to the docstrings, and make report.py use Inventory.total_value() instead of its own loop.",
    "test": "test_inventory.py",
    "files": {
        "inventory.py": _d('''
            class Inventory:
                """Stock of items: name -> (unit_price, quantity)."""

                def __init__(self):
                    self.items = {}

                def add(self, name, unit_price, quantity=1):
                    """Add quantity of an item. If the item exists, increase its quantity and set the new unit_price.
                    Raise ValueError if quantity <= 0 or unit_price < 0."""
                    raise NotImplementedError

                def remove(self, name, quantity=1):
                    """Remove quantity of an item; delete the item when its quantity reaches 0.
                    Raise KeyError if the item is missing and ValueError if removing more than available."""
                    raise NotImplementedError

                def total_value(self):
                    """Sum of unit_price * quantity over all items, rounded to 2 decimals."""
                    raise NotImplementedError
            '''),
        "report.py": _d('''
            def summary(inv):
                total = 0
                for name, (price, qty) in inv.items.items():
                    total += price * qty
                return f"{len(inv.items)} items, value {total:.2f}"
            '''),
        "test_inventory.py": _d('''
            from inventory import Inventory
            from report import summary
            inv = Inventory()
            inv.add("pen", 1.5, 10)
            inv.add("pen", 2.0, 5)
            assert inv.items["pen"] == (2.0, 15)
            inv.add("book", 12.25)
            assert inv.total_value() == 42.25
            inv.remove("pen", 15)
            assert "pen" not in inv.items
            for bad in [lambda: inv.add("x", 1, 0), lambda: inv.add("x", -1, 1), lambda: inv.remove("book", 2)]:
                try:
                    bad()
                except ValueError:
                    pass
                else:
                    raise AssertionError("expected ValueError")
            try:
                inv.remove("ghost")
            except KeyError:
                pass
            else:
                raise AssertionError("expected KeyError")
            assert summary(inv) == "1 items, value 12.25"
            src = open("report.py").read()
            assert "total_value()" in src and "for " not in src, "report.py must use total_value()"
            print("ALL PASS")
            '''),
    },
}
