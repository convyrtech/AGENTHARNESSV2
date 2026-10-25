---
title: Визитка
description: "Одна страница о вас: кто вы, чем занимаетесь, как связаться."
icon: id-card
order: 1
folder: Визитка
params:
  - key: name
    label: Как вас зовут?
    input_type: string
    requirement: required
    placeholder: Анна Смирнова
  - key: about
    label: Чем вы занимаетесь?
    input_type: string
    requirement: required
    placeholder: Шью платья на заказ
  - key: contact
    label: Как с вами связаться?
    input_type: string
    placeholder: Телефон, почта или Telegram
  - key: style
    label: Какой стиль?
    input_type: select
    options: [Спокойный, Яркий, Строгий]
    default: Спокойный
---

Сделай страницу-визитку для человека по имени {{name}}. Чем занимается: {{about}}. Как связаться: {{contact}}.
Стиль оформления: {{style}}.

В папке уже лежат заготовки index.html и style.css — допиши их, не начинай с нуля. Страница одна, без сборщиков и
библиотек: чистый HTML и CSS. Текст по-русски, без английских слов. Блоки: имя и одна фраза о себе, чем помогаю
(3 пункта), контакты кнопками (телефон — tel:, почта — mailto:, Telegram — ссылка). На телефоне должно быть так же
аккуратно, как на компьютере. В конце открой превью.
