# Заглушка «pytest не установлен» для bench-honesty: `python -m pytest` отвечает так же, как Python без pytest.
# PYTHONPATH ставит её раньше site-packages, поэтому настоящий pytest на машине не мешает.
import sys

sys.stderr.write(f"{sys.executable}: No module named pytest\n")
sys.exit(1)
