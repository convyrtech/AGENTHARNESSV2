# PRSLOY Desktop — общий контекст для всех дорожек

Прочитай целиком перед работой. План и сроки: `../../../PLAN-alpha.md`.

## Продукт
- Десктоп-агент для казуальных пользователей в России. Владелец — не программист, пишет коротко по-русски.
- Интерфейс по-русски, коротко, без пояснений очевидного (никаких «Нажмите, чтобы открыть» под кнопкой).
- Модели идут только через OpenAI-совместимый шлюз PRSLOY: `https://api.prsloy.online/v1` по умолчанию, адрес
  можно сменить в настройках. Ключ пользователь вставляет при первом запуске.
- Срок: альфа с установщиком Windows за ~30 часов с 2026-10-25 00:00 UTC. Качество на первом месте, скорость на
  втором. Готовое берём, велосипеды не пишем.

## Код
- `app/` — форк [aletheics/zeno](https://github.com/aletheics/zeno) (MIT): Electron 43 + React 19, Pi SDK 1.4.0 в
  Electron `utilityProcess` (`apps/desktop/src/agent-host`). Прочитай `app/AGENTS.md` (по-китайски: инварианты
  архитектуры, i18n через `t()`, диалоги, тесты на каждый `lib/*.ts`, `pnpm check` + `pnpm test` перед коммитом).
  Архитектура неизменна: `Renderer → Preload → Main → utilityProcess Agent Host → pi SDK`.
- i18n: ключи в `apps/desktop/src/renderer/lib/locales/`. Ключ-источник — `zh`. Дорожка UI добавляет `ru` и
  делает его языком по умолчанию. **Любой новый ключ добавляй во все локали, что есть в твоей ветке (zh, en, ru).**
- `playbooks/site/harness/` — харнесс дизайн-пайплайна на Python: `run.py` (дирижёр шагов, события JSONL),
  `judge.py`, `second_opinion.py`, `a6proxy.py` (прокси надёжности: ключ держит он), `stages.json`, `check.py`.
  `playbooks/site/motion/` — словарь приёмов движения и компоненты `motion.js`.
- Дизайн-пайплайн владельца: репозиторий `convyrtech/design-pipeline` (Python + Playwright).

## Правила работы
- Своя ветка `desktop/<дорожка>` от `main`. Маленькие коммиты, push в свою ветку. `main` не трогаешь, PR не
  открываешь: сливает дирижёр. Раз в час и перед отчётом: `git fetch origin main && git rebase origin/main`.
- Минимум правок в общих больших файлах (`apps/desktop/src/main/index.ts` — 5,7 тыс. строк): своё в новых файлах,
  в общем — только подключение.
- Windows локально не запустить. Сборка и проверки под Windows — GitHub Actions `windows-latest`
  (`.github/workflows/desktop-windows.yml`, `desktop-ci.yml`). Репозиторий публичный, минуты бесплатны.
  API GitHub: `curl -H "Authorization: token $GH_TOKEN" https://api.github.com/repos/convyrtech/AGENTHARNESSV2/...`
  работает (CLI `gh` может говорить, что токен плохой, — не верь ему, curl работает). Логи шага:
  `/actions/jobs/<id>/logs`.
- Ключа шлюза у тебя нет. Для проверок агента — фейковая модель Zeno (`ZENO_ISOLATED=1`) или свой мок
  OpenAI-совместимого сервера. Живые проверки с ключом делает дирижёр.
- Безопасность: не коммить секреты; агентам в приложении не отдавать ключи машины (AWS_*, GH_TOKEN и т. п.);
  не отключать проверку TLS.
- В конце: короткий отчёт в `app/docs/prsloy/STATUS-<дорожка>.md` в своей ветке: что сделано, как проверено
  (команды и вывод), что не сделано и почему.
- Коммиты заканчивай строками:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
