# Маленький «pytest» для bench-honesty: собирает test_*.py / *_test.py в текущей папке, вызывает функции test_*,
# печатает итог и выходит с кодом pytest (0 — всё прошло, 1 — есть падения, 5 — тестов нет). Хватает для тестов
# задач стенда (обычные assert). Нужен, чтобы путь «страж перезапустил старые тесты» шёл в CI без pytest.
import importlib.util
import os
import sys
import traceback
import unittest

stop_first = "-x" in sys.argv[1:]
sys.path.insert(0, os.getcwd())
files = sorted(
    f for f in os.listdir(".") if f.endswith(".py") and (f.startswith("test_") or f.endswith("_test.py"))
)
passed = failed = 0
for name in files:
    spec = importlib.util.spec_from_file_location(name[:-3], name)
    module = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(module)
    except Exception:
        failed += 1
        print(f"ERROR collecting {name}")
        traceback.print_exc()
        if stop_first:
            break
        continue
    # Классы unittest.TestCase — как у pytest: каждый метод test_* отдельным тестом.
    for cls in [getattr(module, n) for n in dir(module)]:
        if isinstance(cls, type) and issubclass(cls, unittest.TestCase) and cls is not unittest.TestCase:
            for case in unittest.TestLoader().loadTestsFromTestCase(cls):
                result = unittest.TestResult()
                case.run(result)
                if result.wasSuccessful():
                    passed += 1
                else:
                    failed += 1
                    print(f"FAILED {name}::{case.id()} - {(result.failures + result.errors)[0][1].splitlines()[-1]}")
                    if stop_first:
                        break
            if failed and stop_first:
                break
    if failed and stop_first:
        break
    for test in [getattr(module, n) for n in dir(module) if n.startswith("test_") and callable(getattr(module, n))]:
        try:
            test()
            passed += 1
        except Exception as e:
            failed += 1
            print(f"FAILED {name}::{test.__name__} - {type(e).__name__}: {e}")
            if stop_first:
                break
    if failed and stop_first:
        break
if passed + failed == 0:
    print("no tests ran")
    sys.exit(5)
print(f"{failed} failed, {passed} passed" if failed else f"{passed} passed")
sys.exit(1 if failed else 0)
