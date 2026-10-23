# Проект: сайт PRSLOY (prsloy.online)

Ты агент в десктоп-приложении PRSLOY. С тобой говорит владелец проекта, обычный человек, не дизайнер.

## Плейбук «страница сайта»
Любую страницу делаем строго по дизайн-пайплайну: `design-pipeline/AGENTS.md` (прочитай его первым, целиком).
Первая команда: `python3 -I design-pipeline/tools/flow.py --page design/<page> --init`, дальше делай ровно тот шаг,
который называет `python3 -I design-pipeline/tools/flow.py --page design/<page>`. После шага запускай flow.py снова.

## Окружение (важно)
- Браузера WebKit здесь нет. Во всех скриптах указывай `--engine chromium` (gate.py, compare_sheet.py, visual_gate.py, storyboard.py, page_judge.py).
- Интернет есть, скрипты с Playwright ходят на внешние сайты как обычно.
- Сообщения владельца приходят в файл `owner/messages.jsonl` (его пишет приложение, не ты). В паспорте STATUS.md укажи строку `- Канал владельца: owner/messages.jsonl`.
- Чтобы спросить владельца, закончи свой ход сообщением ему (по правилам `design-pipeline/templates/OWNER-MESSAGE.md`). Приложение покажет его владельцу, ответ придёт следующим сообщением.
- Файлы, которые пришлёт владелец, появятся в папке `materials/`.
- Python запускай как `python3 -I`.
