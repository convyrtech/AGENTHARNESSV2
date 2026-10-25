/**
 * The agent status line in words: the host and the app set fixed English service strings
 * («Agent settled», «Agent Host ready»; tests read them from the hidden probe), and the visible
 * line shows them in the owner's language. Strings already translated pass through.
 */
import { t, type Locale, type MessageKey } from "./i18n.ts";

const FIXED: Readonly<Record<string, MessageKey>> = {
  "Agent settled": "hostStatus.settled",
  "Agent running...": "hostStatus.running",
  "Agent aborted": "hostStatus.aborted",
  "Agent Host ready": "hostStatus.ready",
  "Agent Host restarted": "hostStatus.restarted",
  "Guidance queued": "hostStatus.queued",
  "Follow-up queued": "hostStatus.queued",
  "Queued messages cleared": "hostStatus.queueCleared",
  "Abort requested — waiting for agent to stop…": "hostStatus.stopping",
  "Project trusted": "hostStatus.trusted",
  "正在启动 Agent Host…": "hostStatus.starting",
};

export function hostStatusLabel(status: string, locale: Locale): string {
  const fixed = FIXED[status];
  if (fixed) return t(locale, fixed);
  const retry = /^Retrying (\d+)\/(\d+)…$/u.exec(status);
  if (retry) return t(locale, "hostStatus.retrying", { n: retry[1]!, total: retry[2]! });
  if (/^(Opening workspace|Resuming) /u.test(status)) return t(locale, "hostStatus.opening");
  return status;
}
