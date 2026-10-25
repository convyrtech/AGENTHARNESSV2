---
title: Бот для Telegram
description: Бот, который отвечает на сообщения. Токен вводится в отдельном окне, не в чат.
icon: bot
order: 3
folder: Бот
params:
  - key: purpose
    label: Что делает бот?
    input_type: string
    requirement: required
    placeholder: Принимает заказы на торты
  - key: greeting
    label: Что бот пишет на /start?
    input_type: string
    default: Привет! Я помогу оформить заказ.
  - key: buttons
    label: Кнопки меню
    input_type: boolean
    default: true
---

Сделай бота для Telegram на Python. Что делает бот: {{purpose}}. На /start бот пишет: «{{greeting}}». Кнопки меню
под сообщением: {{buttons}}.

В папке уже есть заготовка bot.py (без сторонних библиотек: только стандартный Python и Bot API по HTTPS) и
.env.example — допиши бота в bot.py. Токен бота мне в чат не пиши и не проси его в чате: попроси его инструментом
request_secret с именем TELEGRAM_BOT_TOKEN, он сохранится в .env, а бот читает его из окружения. Ответы бота по-русски,
простыми словами. Запусти бота через bash_background и проверь по журналу, что он отвечает. Коротко объясни мне, как
его остановить и запустить снова.
