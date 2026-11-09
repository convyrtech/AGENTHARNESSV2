# #103 — фиксированная модель на стенде

Ветка `work/103-bench-fixed-model`, база `43841f6`. Это предварительная часть
сравнения моделей, не реализация оркестратора.

## Изменение

`createPrsloyFetch` и `installPrsloyFetch` принимают `modelFallback?: boolean`.
При false ошибка выбранной модели возвращается без каталога, замены модели
и callback. Bench устанавливает false, чтобы не приписывать ответ замены
исходной модели. Приложение сохраняет прежнее поведение по умолчанию.
Уменьшение max_tokens на 400/402, кэш лимита, marker и AbortSignal сохраняются.

Перенесена минимальная правка из живого пилота, дополненная исправлением
TS2379 (`exactOptionalPropertyTypes`) и штатными регрессионными тестами.
Полный протокол и сырые ответы остаются локально, обезличенный итог — DIARY.md.

## Проверка

- До изменения: новый adapter suite — 4 failed / 4 passed; bench regression
  с недоступной Kimi и доступным fallback не получил ожидаемый infra_error.
- После: `vp test --run --config apps/desktop/vite.renderer.config.ts
apps/desktop/src/agent-host/prsloy-fetch.test.ts
apps/desktop/src/main/prsloy/prsloy-models.test.ts` — 18/18.
- `vp check` — 1173 файла, без ошибок типов, lint и format.
- `vp test --run test/bench-meter.test.ts` — 12 pass / 1 fail; новая проверка
  проходит. Падает прежний budget test: fix-discount ошибочно классифицируется
  cheat на Node 24; отдельное исправление #109 ещё не слито.
- Полный `pnpm test` выполнен, красный; в desktop-наборе 11 failed / 1554 passed,
  25 skipped и одна unhandled error. Не все ошибки подтверждены как baseline.
- Независимое source review интеграции: дополнительных дефектов не найдено.

## Границы результата

Live-пилот проверял изменение адаптера в изолированной задаче. Интеграционный
bench regression использует локальный mock gateway, не платную модель.
Полный CI и тестовый набор должны стать зелёными до merge/release. Alpha 5
не принята, сборка не опубликована, новая настройка в пользовательский UI
не добавляется. Релиз и полноценный оркестратор остаются отдельной работой.
