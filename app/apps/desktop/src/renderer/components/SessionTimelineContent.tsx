import type { HostEvent } from "@zeno/contracts";
import { Fragment, useMemo, type ReactNode, type Ref } from "react";
import {
  MessageScroller,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { cn } from "@/lib/utils";
import {
  buildTimelineBlocks,
  deriveLiveActivity,
  processBlockCoversLiveActivity,
  type TimelineItem,
} from "@/lib/timeline";
import { ConversationMinimap } from "./ConversationMinimap.tsx";
import { TimelineLiveStatus, TimelineProcessBlock, TimelineRow } from "./TimelineRow.tsx";
import type { Locale } from "@/lib/i18n";
import { matchTurnSnapshots, timelineTurns } from "@/lib/turn-undo";
import { useTurnSnapshots } from "../hooks/useTurnSnapshots.ts";
import { TurnUndoAction } from "./TurnUndoAction.tsx";
import { TurnPreviewAction } from "./TurnPreviewAction.tsx";
import { previewTargetsByBlock } from "@/lib/turn-preview";
import { withoutRetryNoise } from "@/lib/model-failure";
import { useCasualPrefs } from "../hooks/useCasualPrefs.ts";

type UserTimelineItem = Extract<TimelineItem, { kind: "user" }>;
type AssistantTimelineItem = Extract<TimelineItem, { kind: "assistant" }>;

export type SessionTimelineContentProps = {
  items: TimelineItem[];
  events: HostEvent[];
  running: boolean;
  waiting: boolean;
  locale: Locale;
  sessionKey?: string;
  workspacePath?: string;
  /** The session's own cwd (also set for chats without a project): base of the agent's paths. */
  sessionCwd?: string | undefined;
  ready?: boolean;
  editingLocked?: boolean;
  onEditUser?: (item: UserTimelineItem, text: string) => void | Promise<void>;
  onForkAssistant?: (item: AssistantTimelineItem) => void | Promise<void>;
  /** «Повторить» on a failed turn: send that turn's prompt again. */
  onResend?: (text: string) => void;
  endRef?: Ref<HTMLDivElement>;
  emptyState?: ReactNode;
  footer?: ReactNode;
  testId?: string;
};

export type SessionTimelineScrollerProps = SessionTimelineContentProps & {
  autoScroll: boolean;
  viewportRef?: Ref<HTMLDivElement>;
  viewportClassName?: string;
  viewportSizing?: "fill" | "content";
  viewportBusy?: boolean;
  viewportReady?: boolean;
};

export const SESSION_SCROLL_BOTTOM_GAP_PX = 64;

/** Full product scroll surface shared by the desktop app and the browser demo */
export function SessionTimelineScroller(props: SessionTimelineScrollerProps) {
  const {
    autoScroll,
    viewportRef,
    viewportClassName,
    viewportSizing = "fill",
    viewportBusy,
    viewportReady,
    ...contentProps
  } = props;

  return (
    <MessageScrollerProvider
      autoScroll={autoScroll}
      defaultScrollPosition="end"
      scrollEdgeThreshold={SESSION_SCROLL_BOTTOM_GAP_PX}
    >
      <MessageScroller className="size-full min-h-0">
        <MessageScrollerViewport
          ref={viewportRef}
          className={cn(
            "timeline-scroll thread-pane-scroll min-h-0",
            viewportSizing === "content" ? "h-auto w-full" : "size-full",
            viewportClassName,
          )}
          aria-busy={viewportBusy}
          data-ready={viewportReady == null ? undefined : viewportReady ? "true" : "false"}
        >
          <SessionTimelineContent {...contentProps} />
        </MessageScrollerViewport>
        {/* Sibling of the viewport, not a child: the rail must not scroll with the
         * transcript. It anchors to MessageScroller's relative box, and must stay
         * inside the provider for the message-scroller hooks to resolve. */}
        <ConversationMinimap items={contentProps.items} locale={contentProps.locale} />
      </MessageScroller>
    </MessageScrollerProvider>
  );
}

/** Product session timeline shared by the desktop app and the browser demo */
export function SessionTimelineContent(props: SessionTimelineContentProps) {
  const {
    items,
    events,
    running,
    waiting,
    locale,
    sessionKey = "",
    ready = true,
    editingLocked = running,
    emptyState,
    footer,
    testId = "timeline",
  } = props;
  const { developerMode } = useCasualPrefs();
  const blocks = useMemo(
    () => buildTimelineBlocks(developerMode ? items : withoutRetryNoise(items)),
    [items, developerMode],
  );
  const liveActivity = useMemo(
    () => deriveLiveActivity({ items, events, running, waiting }),
    [items, events, running, waiting],
  );
  const hasActivity = items.length > 0;
  /** Prompt of the turn being rendered, so a failure card can resend it. */
  let turnPrompt: string | undefined;
  // «Откатить» after each finished turn that changed files, keyed by the turn's last block.
  const snapshots = useTurnSnapshots(running, `${sessionKey}:${items.length}`);
  const undoAfterBlock = useMemo(() => {
    const turns = timelineTurns(blocks, running).filter((turn) => turn.changedFiles);
    const matched = matchTurnSnapshots(turns, snapshots);
    const byBlock = new Map<number, string>();
    for (const turn of turns) {
      const snapshotId = matched.get(turn.userId);
      if (snapshotId) byBlock.set(turn.lastBlockIndex, snapshotId);
    }
    return byBlock;
  }, [blocks, running, snapshots]);
  // «Открыть превью» after a finished turn that wrote a page or started a local server.
  const previewAfterBlock = useMemo(
    () => previewTargetsByBlock(blocks, running),
    [blocks, running],
  );
  const showLiveStatus =
    liveActivity != null && !processBlockCoversLiveActivity(blocks, liveActivity);

  return (
    <MessageScrollerContent
      className={cn(
        "thread-content-column thread-content-column-stack gap-0",
        hasActivity && "thread-messages-active pt-6 pb-0",
      )}
      data-testid={testId}
      data-content-mode="chat"
    >
      {hasActivity ? (
        <>
          {blocks.map((block, index) => {
            const messageId = block.type === "process" ? block.id : block.item.id;
            if (block.type === "item" && block.item.kind === "user") turnPrompt = block.item.text;
            const resendText = turnPrompt;
            const undoSnapshotId = undoAfterBlock.get(index);
            const previewTarget = previewAfterBlock.get(index);
            return (
              <Fragment key={messageId}>
                <MessageScrollerItem messageId={messageId} scrollAnchor={false} className="w-full">
                  {block.type === "process" ? (
                    <TimelineProcessBlock
                      locale={locale}
                      items={block.items}
                      open={block.open}
                      running={running}
                      waiting={waiting}
                      {...(block.open && liveActivity?.phase
                        ? { livePhase: liveActivity.phase }
                        : {})}
                      {...(block.startedAt ? { startedAt: block.startedAt } : {})}
                      {...(block.endedAt ? { endedAt: block.endedAt } : {})}
                      {...(block.durationLabel ? { durationLabel: block.durationLabel } : {})}
                      {...(props.workspacePath ? { workspacePath: props.workspacePath } : {})}
                    />
                  ) : (
                    <TimelineRow
                      item={block.item}
                      locale={locale}
                      editingLocked={editingLocked}
                      {...(props.workspacePath ? { workspacePath: props.workspacePath } : {})}
                      {...(props.onEditUser ? { onEditUser: props.onEditUser } : {})}
                      {...(props.onForkAssistant ? { onForkAssistant: props.onForkAssistant } : {})}
                      {...(props.onResend && resendText
                        ? { onRetry: () => props.onResend?.(resendText) }
                        : {})}
                    />
                  )}
                </MessageScrollerItem>
                {undoSnapshotId || previewTarget ? (
                  <MessageScrollerItem
                    messageId={`${messageId}:undo`}
                    scrollAnchor={false}
                    className="turn-actions w-full"
                  >
                    {undoSnapshotId ? (
                      <TurnUndoAction
                        key={undoSnapshotId}
                        locale={locale}
                        snapshotId={undoSnapshotId}
                        disabled={running}
                      />
                    ) : null}
                    {previewTarget ? (
                      <TurnPreviewAction
                        locale={locale}
                        target={previewTarget}
                        workspacePath={props.sessionCwd || props.workspacePath}
                        snapshotId={undoSnapshotId}
                      />
                    ) : null}
                  </MessageScrollerItem>
                ) : null}
              </Fragment>
            );
          })}
          {showLiveStatus && liveActivity ? (
            <MessageScrollerItem
              messageId={`${sessionKey || "live"}:live-status`}
              className="w-full"
            >
              <TimelineLiveStatus locale={locale} activity={liveActivity} />
            </MessageScrollerItem>
          ) : null}
          <div ref={props.endRef} className="h-px w-full shrink-0" aria-hidden />
        </>
      ) : ready ? (
        emptyState
      ) : null}
      {footer}
    </MessageScrollerContent>
  );
}
