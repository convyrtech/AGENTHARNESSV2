---
title: Простая игра
description: "Игра в браузере: открыть и играть, без установки."
icon: gamepad
order: 5
folder: Игра
params:
  - key: game
    label: Какая игра?
    input_type: select
    options: [Змейка, Угадай число, Крестики-нолики, Арканоид]
    default: Змейка
  - key: level
    label: Сложность
    input_type: select
    options: [Лёгкая, Средняя, Трудная]
    default: Средняя
  - key: wish
    label: Что ещё хочется?
    input_type: string
    placeholder: Счёт очков и рекорд
---

Сделай игру «{{game}}» в браузере. Сложность: {{level}}. Пожелания: {{wish}}.

В папке уже есть заготовки index.html и game.js — допиши их. Без сборщиков и библиотек: HTML, CSS и JavaScript
(canvas, если нужен). Управление с клавиатуры и пальцем на телефоне. Подсказка «как играть» на экране, кнопка
«Заново», счёт. Все надписи по-русски. В конце открой превью.
