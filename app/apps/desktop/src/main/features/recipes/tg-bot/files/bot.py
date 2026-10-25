"""Бот для Telegram: стандартный Python, Bot API по HTTPS. Токен — из .env (TELEGRAM_BOT_TOKEN)."""
import json
import os
import time
import urllib.parse
import urllib.request


def load_env(path=".env"):
    if not os.path.exists(path):
        return
    with open(path, encoding="utf-8") as f:
        for line in f:
            key, sep, value = line.strip().partition("=")
            if sep and key and not key.startswith("#"):
                os.environ.setdefault(key, value)


def api(token, method, **params):
    data = urllib.parse.urlencode(params).encode()
    with urllib.request.urlopen(f"https://api.telegram.org/bot{token}/{method}", data, timeout=60) as r:
        return json.loads(r.read().decode())


def reply(text):
    return "Пока я только учусь. Скоро отвечу по делу."


def main():
    load_env()
    token = os.environ.get("TELEGRAM_BOT_TOKEN")
    if not token:
        raise SystemExit("Нет TELEGRAM_BOT_TOKEN в .env")
    offset = 0
    print("Бот запущен", flush=True)
    while True:
        try:
            updates = api(token, "getUpdates", offset=offset, timeout=50).get("result", [])
        except OSError as error:
            print("Нет связи с Telegram:", error, flush=True)
            time.sleep(5)
            continue
        for update in updates:
            offset = update["update_id"] + 1
            message = update.get("message") or {}
            text = message.get("text")
            if text:
                api(token, "sendMessage", chat_id=message["chat"]["id"], text=reply(text))


if __name__ == "__main__":
    main()
