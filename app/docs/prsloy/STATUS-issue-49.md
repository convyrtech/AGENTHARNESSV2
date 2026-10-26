# Issue #49 — версия PRSLOY в настройках

Ветка: `work/settings-version`.

## Что сделано

- В «Настройки → Аккаунт» внизу добавлен блок «О программе» со строкой «PRSLOY» и текущей версией.
- Версия берётся из `currentVersion` уже существующего статуса обновлений; в main он заполняется через `app.getVersion()`. Отдельного номера версии в интерфейсе нет.
- Клик по версии копирует только номер. Успех и ошибка копирования показаны в строке; во время записи кнопка отключена.
- Если статус недоступен или версия пуста, кнопка не показывается.
- Тексты добавлены в `zh`, `en`, `ru`.

## Проверки

Исходный `main` (7eb0dc2), до изменений:

- `cd app && corepack pnpm check` → `All 1352 files are correctly formatted`; `Found no warnings, lint errors, or type errors in 1102 files`.
- `cd app && corepack pnpm test` → exit 1. Уже падали соседние тесты agent-runtime (6 файлов / 7 тестов) и desktop (в том числе `pi-tui-pty`, `research`, `runtime-provision`, `design/paths`).

После изменений:

- `corepack pnpm --filter @zeno/desktop exec vp test --run --config vite.renderer.config.ts src/renderer/components/settings/AppVersionRow.test.tsx src/renderer/components/settings/AccountSection.test.tsx src/renderer/lib/i18n.test.ts src/renderer/components/prsloy/UpdateReadyNotice.test.tsx src/renderer/components/settings/SettingsPage.locale.test.tsx` → `Test Files 5 passed (5)`, `Tests 30 passed (30)`.
- `corepack pnpm check` → `All 1354 files are correctly formatted`; `Found no warnings, lint errors, or type errors in 1104 files`.
- `corepack pnpm test` → exit 1. Повторились старые падения: agent-runtime `6 failed | 23 passed` файлов, `7 failed | 115 passed` тестов; desktop по-прежнему падает в том числе на `pi-tui-pty`, `research`, `runtime-provision`, `design/paths`. Новые тесты в полном прогоне прошли. Тесты не отключены и не ослаблены.
- `git diff --check` → пустой вывод, exit 0.

## Не проверено локально

- Реальное окно Electron и системный буфер обмена Windows: рендер и оба исхода копирования проверены в jsdom, живое окно не запускалось.
- Зелёный полный локальный `pnpm test`: есть исходные падения, перечисленные выше.
- GitHub `desktop-ci` и Windows-прогон: запускаются после push; результат будет записан в issue. Слияние — только при зелёном `desktop-ci`.
