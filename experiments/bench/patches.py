"""Reference (correct) and subtly wrong patches for the review experiment. Each value: dict of changed files."""
import tasks
T = tasks.T
PAG = T["paginate"]["files"]["pager.py"]
SLUG = T["slugify"]["files"]["text_utils.py"]
UNITS = T["bigfile"]["files"]["units.py"]

def _slug(body):
    return SLUG.replace("    raise NotImplementedError", body)

INV_HEAD = ('class Inventory:\n    """Stock of items: name -> (unit_price, quantity)."""\n\n    def __init__(self):\n        self.items = {}\n\n')
INV_ADD_OK = ('    def add(self, name, unit_price, quantity=1):\n        if quantity <= 0 or unit_price < 0:\n            raise ValueError("bad quantity or price")\n'
              '        _, q = self.items.get(name, (unit_price, 0))\n        self.items[name] = (unit_price, q + quantity)\n\n')
INV_REMOVE_OK = ('    def remove(self, name, quantity=1):\n        if name not in self.items:\n            raise KeyError(name)\n        price, q = self.items[name]\n'
                 '        if quantity > q:\n            raise ValueError("not enough stock")\n        if q == quantity:\n            del self.items[name]\n        else:\n            self.items[name] = (price, q - quantity)\n\n')
INV_TOTAL = '    def total_value(self):\n        return round(sum(p * q for p, q in self.items.values()), 2)\n'
REPORT_OK = 'def summary(inv):\n    return f"{len(inv.items)} items, value {inv.total_value():.2f}"\n'

CSV_OK = ('def parse_csv_line(line):\n    """Split one CSV line into fields (see tests for the exact rules)."""\n    fields, cur, quoted, i = [], "", False, 0\n'
          '    while i < len(line):\n        ch = line[i]\n        if quoted:\n            if ch == \'"\':\n                if i + 1 < len(line) and line[i + 1] == \'"\':\n'
          '                    cur += \'"\'\n                    i += 1\n                else:\n                    quoted = False\n            else:\n                cur += ch\n'
          '        elif ch == ",":\n            fields.append(cur)\n            cur = ""\n        elif ch == \'"\' and cur == "":\n            quoted = True\n        else:\n            cur += ch\n'
          '        i += 1\n    fields.append(cur)\n    return fields\n')

PATCHES = {
 "paginate": [
  ("ok", {"pager.py": PAG.replace("    start = page * size", "    if page < 1:\n        raise ValueError(page)\n    start = (page - 1) * size")}),
  ("bug", {"pager.py": PAG.replace("    start = page * size", "    if page < 0:\n        raise ValueError(page)\n    start = (page - 1) * size")}),
  ("bug", {"pager.py": PAG.replace("    start = page * size\n    return items[start:start + size]", "    if page < 1:\n        raise ValueError(page)\n    start = (page - 1) * size\n    return items[start:start + size - 1]")}),
 ],
 "slugify": [
  ("ok", {"text_utils.py": _slug("    import re\n    t = unicodedata.normalize('NFKD', text).encode('ascii', 'ignore').decode().lower()\n    return re.sub(r'[^a-z0-9]+', '-', t).strip('-')")}),
  ("bug", {"text_utils.py": _slug("    import re\n    t = unicodedata.normalize('NFKD', text).encode('ascii', 'ignore').decode().lower()\n    return re.sub(r'[^a-z0-9]+', '-', t).lstrip('-')")}),
  ("bug", {"text_utils.py": _slug("    import re\n    t = text.lower()\n    return re.sub(r'[^a-z0-9]+', '-', t).strip('-')")}),
 ],
 "rename": [
  ("ok", {f: c.replace("calc_total", "compute_total") for f, c in T["rename"]["files"].items() if not f.startswith("test")}),
  ("bug", {"billing.py": T["rename"]["files"]["billing.py"].replace("calc_total", "compute_total"),
           "report.py": T["rename"]["files"]["report.py"].replace("from billing import calc_total, calc_tax", "from billing import compute_total as calc_total, calc_tax")}),
  ("bug", {"billing.py": T["rename"]["files"]["billing.py"].replace("def calc_total", "def compute_total"),
           "report.py": T["rename"]["files"]["report.py"].replace("calc_total", "compute_total")}),
 ],
 "duration": [
  ("ok", {"durations.py": T["duration"]["files"]["durations.py"].replace('(?:(\\d+)m)?", s)\n    if not m:', '(?:(\\d+)m)?(?:(\\d+)s)?", s)\n    if not s or not m:').replace("h, mnt = m.groups()\n    return int(h or 0) * 3600 + int(mnt or 0) * 60", "h, mnt, sec = m.groups()\n    return int(h or 0) * 3600 + int(mnt or 0) * 60 + int(sec or 0)")}),
  ("bug", {"durations.py": T["duration"]["files"]["durations.py"].replace('(?:(\\d+)m)?", s)', '(?:(\\d+)m)?(?:(\\d+)s)?", s)').replace("h, mnt = m.groups()\n    return int(h or 0) * 3600 + int(mnt or 0) * 60", "h, mnt, sec = m.groups()\n    return int(h or 0) * 3600 + int(mnt or 0) * 60 + int(sec or 0)")}),
  ("bug", {"durations.py": T["duration"]["files"]["durations.py"].replace('(?:(\\d+)m)?", s)\n    if not m:', '(?:(\\d+)m)?(?:(\\d+)s)?", s)\n    if not s or not m:').replace("h, mnt = m.groups()\n    return int(h or 0) * 3600 + int(mnt or 0) * 60", "h, mnt, sec = m.groups()\n    return int(h or 0) * 3600 + int(mnt or 0) * 60 + int(sec or 0) * 60")}),
 ],
 "words": [
  ("ok", {"wordcount.py": T["words"]["files"]["wordcount.py"].replace("def count_words(text):", "def count_words(text, ignore_case=False):").replace("        w = w.strip(\".,!?;:\")\n", "        w = w.strip(\".,!?;:\")\n        if ignore_case:\n            w = w.lower()\n")}),
  ("bug", {"wordcount.py": T["words"]["files"]["wordcount.py"].replace("def count_words(text):", "def count_words(text, ignore_case=True):").replace("        w = w.strip(\".,!?;:\")\n", "        w = w.strip(\".,!?;:\")\n        if ignore_case:\n            w = w.lower()\n")}),
  ("bug", {"wordcount.py": T["words"]["files"]["wordcount.py"].replace("def count_words(text):", "def count_words(text, ignore_case=False):").replace("    for w in text.split():\n", "    if ignore_case:\n        text.lower()\n    for w in text.split():\n")}),
 ],
 "bigfile": [
  ("ok", {"units.py": UNITS.replace('unit 17."""\n    if v is None:\n        return None', 'unit 17."""\n    if v is None:\n        return 0')}),
  ("bug", {"units.py": UNITS.replace('unit 17."""\n    if v is None:\n        return None', 'unit 17."""\n    if v is None:\n        return "0"')}),
  ("bug", {"units.py": UNITS.replace('unit 1."""\n    if v is None:\n        return None', 'unit 1."""\n    if v is None:\n        return 0').replace('unit 17."""\n    if v is None:\n        return None', 'unit 17."""\n    if v is None:\n        return 0')}),
 ],
 "csvline": [
  ("ok", {"csvline.py": CSV_OK}),
  ("bug", {"csvline.py": CSV_OK.replace('                if i + 1 < len(line) and line[i + 1] == \'"\':\n                    cur += \'"\'\n                    i += 1\n                else:\n                    quoted = False', '                quoted = False')}),
  ("bug", {"csvline.py": CSV_OK.replace("    fields.append(cur)\n    return fields", "    fields.append(cur)\n    return [f.strip() for f in fields]")}),
 ],
 "inventory": [
  ("ok", {"inventory.py": INV_HEAD + INV_ADD_OK + INV_REMOVE_OK + INV_TOTAL, "report.py": REPORT_OK}),
  ("bug", {"inventory.py": INV_HEAD + INV_ADD_OK.replace("self.items[name] = (unit_price, q + quantity)", "price = self.items.get(name, (unit_price, 0))[0]\n        self.items[name] = (price, q + quantity)") + INV_REMOVE_OK + INV_TOTAL, "report.py": REPORT_OK}),
  ("bug", {"inventory.py": INV_HEAD + INV_ADD_OK + INV_REMOVE_OK.replace("        if quantity > q:\n            raise ValueError(\"not enough stock\")\n        if q == quantity:", "        if q <= quantity:") + INV_TOTAL, "report.py": REPORT_OK}),
 ],
}
