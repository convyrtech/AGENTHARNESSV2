# Слито в alpha.3 (26.10)

- `desktop/harness-python-gate` (#37) — stop-gate берёт python из `.venv`/`venv` проекта; нет pytest — fallback на
  `unittest discover` с подписью «проверено через unittest» в turn-status; голые pytest-функции без pytest — «нечем
  проверить», а не «прошло».
- `desktop/harness-tests-outdated-on-gate` (#25) — testGuard on by default: правка старых тестов без явной просьбы
  возвращается гейтом; карточка `prsloy-harness.tests-outdated` «Старые тесты расходятся с вашей просьбой» с
  кнопками «Обновить тесты» / «Оставить как есть».
- `desktop/harness-stale-docs-variants` + дефолт `staleDocs: "end"` — секция после `<project_context>`: AGENTS.md /
  README против кода, «следуй коду и назови расхождение» (kimi 1/6 → 6/6).
- `desktop/harness-max-tokens` (#39) — `max_tokens` по модели, step-down 64k → 32k → 16k → 8k на 400/402 с
  запоминанием на 10 минут; раньше kimi на 402 от поставщика не отвечал вовсе.
- `desktop/harness-bench-meter` — счётчик токенов шлюза в бенче, `infra_error`, `--budget-*`, `bench/prices.json`
  (только стенд, в приложении не видно).
- turn-status не показывается после ошибки модели (401/402): под карточкой «Ключ не подходит» больше нет «Проверить
  нечем».
