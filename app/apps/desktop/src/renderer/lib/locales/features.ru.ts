/**
 * Messages of the features taken from open-source analogs (research 19 §1), ru.
 */
import type { featuresZh } from "./features.zh.ts";

export const featuresRu: Record<keyof typeof featuresZh, string> = {
  "features.history.open": "История версий",
  "features.history.title": "История версий",
  "features.history.hint":
    "Перед каждой просьбой файлы проекта сохраняются. Можно вернуть их как были до любой из них.",
  "features.history.empty": "Версий пока нет: они появятся после первой просьбы.",
  "features.history.loading": "Загружаю…",
  "features.history.beforeUndo": "Перед откатом",
  "features.history.noText": "(без текста)",
  "features.history.today": "сегодня {time}",
  "features.history.yesterday": "вчера {time}",
  "features.history.restore": "Вернуть",
  "features.history.confirmTitle": "Вернуть эту версию?",
  "features.history.confirmMessage":
    "Файлы станут как до «{what}». Нынешнее состояние останется в истории — его тоже можно вернуть.",
  "features.history.close": "Закрыть",
  "features.zip.action": "Скачать архив",
  "features.zip.saved": "Архив сохранён: {name}",
  "features.zip.empty": "В проекте нет файлов для архива.",
  "features.zip.tooBig": "Проект больше 200 МБ — архив не собрать.",
  "features.zip.failed": "Не получилось сохранить архив.",
  "features.pick.start": "Выбрать на странице",
  "features.pick.cancel": "Отменить выбор",
  "features.pick.hint": "Нажмите на место, которое надо поменять. Esc — отмена.",
  "features.pick.picked": "Выбрано: {what}. Напишите внизу, что поменять.",
  "features.pick.block.title": "Место на странице {page}",
  "features.pick.block.element": "Элемент",
  "features.pick.block.text": "Текст",
  "features.pick.block.code": "Код",
  "features.errors.one": "На странице ошибка",
  "features.errors.many": "Ошибок на странице: {count}",
  "features.errors.fix": "Починить",
  "features.errors.hide": "Скрыть",
  "features.errors.prompt": "Исправь ошибки на странице {page}. Что показывает браузер:",
  "features.errors.missing": "не загрузился файл {file}",
  "features.pick.block.ask": "Что поменять здесь:",
};
