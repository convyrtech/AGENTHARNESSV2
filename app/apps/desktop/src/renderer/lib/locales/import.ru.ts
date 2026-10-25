/**
 * Chats from other agents (#22 I1): first-run step and settings, ru.
 */
import type { importZh } from "./import.zh.ts";

export const importRu: Record<keyof typeof importZh, string> = {
  "prsloy.import.scanning": "Ищу чаты из других программ…",
  "prsloy.import.title": "Перенести чаты из других программ?",
  "prsloy.import.lead":
    "Нашёл на этом компьютере переписку с другими помощниками. Перенесу её сюда — продолжите с того же места.",
  "prsloy.import.note":
    "Возьму чаты за последние 30 дней, не больше 50. Ваши файлы останутся как были.",
  "prsloy.import.chats.one": "{count} чат",
  "prsloy.import.chats.few": "{count} чата",
  "prsloy.import.chats.many": "{count} чатов",
  "prsloy.import.projects.one": " в {count} проекте",
  "prsloy.import.projects.few": " в {count} проектах",
  "prsloy.import.projects.many": " в {count} проектах",
  "prsloy.import.submit": "Перенести",
  "prsloy.import.later": "Не сейчас",
  "prsloy.import.running": "Переношу… {done} из {total}",
  "prsloy.import.imported.one": "Перенёс {count} чат",
  "prsloy.import.imported.few": "Перенёс {count} чата",
  "prsloy.import.imported.many": "Перенёс {count} чатов",
  "prsloy.import.skipped": "Не перенёс: {count} (папки проекта уже нет или чат пустой)",
  "prsloy.import.next": "Дальше",
  "prsloy.import.failed": "Не получилось перенести чаты: {message}",
  "prsloy.import.nothing": "Чатов из других программ не нашёл.",
  "prsloy.import.settingsTitle": "Чаты из других программ",
  "prsloy.import.settingsHint":
    "Перенесу сюда переписку из Claude Code, Codex и других, чтобы продолжить её здесь.",
  "prsloy.import.find": "Найти чаты",
};
