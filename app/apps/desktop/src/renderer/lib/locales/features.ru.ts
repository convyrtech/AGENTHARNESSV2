/**
 * Messages of the features taken from open-source analogs (research 19 §1), ru.
 */
import type { featuresZh } from "./features.zh.ts";

export const featuresRu: Record<keyof typeof featuresZh, string> = {
  "features.pick.start": "Выбрать на странице",
  "features.pick.cancel": "Отменить выбор",
  "features.pick.hint": "Нажмите на место, которое надо поменять. Esc — отмена.",
  "features.pick.picked": "Выбрано: {what}. Напишите внизу, что поменять.",
  "features.pick.block.title": "Место на странице {page}",
  "features.pick.block.element": "Элемент",
  "features.pick.block.text": "Текст",
  "features.pick.block.code": "Код",
  "features.pick.block.ask": "Что поменять здесь:",
};
