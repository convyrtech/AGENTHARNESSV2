/**
 * Shared between the timeline (which renders only the tail of long chats) and the
 * minimap (which may jump to a message that is not rendered yet).
 */
import { createContext, useContext } from "react";

export type TimelineWindowApi = {
  /** Is this block id rendered right now? */
  isRendered(messageId: string): boolean;
  /** Render the whole chat (then the caller scrolls to its target). */
  showAll(): void;
};

const ALWAYS_RENDERED: TimelineWindowApi = { isRendered: () => true, showAll: () => undefined };

export const TimelineWindowContext = createContext<TimelineWindowApi>(ALWAYS_RENDERED);

export function useTimelineWindow(): TimelineWindowApi {
  return useContext(TimelineWindowContext);
}
