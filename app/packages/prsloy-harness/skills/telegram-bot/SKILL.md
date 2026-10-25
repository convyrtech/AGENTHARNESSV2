---
name: telegram-bot
description: "Бот для Telegram на Python (python-telegram-bot 22): токен от @BotFather через request_secret, .env, запуск через bash_background, как остановить и перезапустить."
---

# Бот для Telegram

Library: **python-telegram-bot** (v22, Python ≥3.10, docs and examples for every feature). Start from `bot.py`
next to this file: it reads the token from `.env` and answers /start and text messages.

## Plan

1. Token: call `request_secret` with `name: "TELEGRAM_BOT_TOKEN"` and a reason like «Токен бота — его выдаёт
   @BotFather в Telegram: /newbot, имя, адрес бота». Never ask for the token in the chat, never print it, never put
   it into code. The tool writes it to `.env` and adds `.env` to `.gitignore`.
2. Check the package with find_ready (`ecosystem: "pypi"`, `candidates: ["python-telegram-bot", "python-dotenv"]`): if the latest major is
   not 22, use it and its docs. Project venv: `python -m venv .venv`, then `.venv/Scripts/python -m pip install python-telegram-bot==22.* python-dotenv`
   (on Linux/macOS `.venv/bin/python`). Write `requirements.txt` with the same two lines.
3. Copy `bot.py`, change the handlers to what the user asked. Keep `load_dotenv()` and the `httpx` logger at
   WARNING: request URLs contain the token, and INFO logs would print it.
4. Run it with **bash_background**: `.venv/Scripts/python bot.py`. It keeps running (polling); never run it with
   plain bash — that blocks until the timeout. Read its output with `process` action=logs.
5. Check: the log shows no traceback; ask the user to send /start to the bot (the one thing only they can do) or,
   if they already did, look for the update in the log.
6. Stop / restart: `process` action=stop with the id. Only **one** copy may poll: a second one gets `telegram.error.Conflict`
   («a long poll … conflicts with another one»). Stop the old one before starting a new one.

## Pitfalls

- `telegram.error.InvalidToken` (on start, when the bot first talks to Telegram) — the token in `.env` is wrong
  or has spaces; ask again with request_secret.
- Handlers are `async def` and must `await update.message.reply_text(...)`.
- The bot works only while the program runs on this computer. Say so in the final message: when the computer
  sleeps or the app is closed, the bot is silent. Hosting is a separate task.

## Sources

- python-telegram-bot docs: https://docs.python-telegram-bot.org/en/stable/
- Echo bot example: https://docs.python-telegram-bot.org/en/stable/examples.echobot.html
- Telegram bot tutorial: https://core.telegram.org/bots/tutorial
- BotFather: https://core.telegram.org/bots/features#botfather
- python-dotenv: https://pypi.org/project/python-dotenv/
