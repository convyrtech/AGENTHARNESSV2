import type { HostEvent } from "@zeno/contracts";
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
  type Ref,
} from "react";
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
import { t, type Locale } from "@/lib/i18n";
import {
  nextTimelineLimit,
  TIMELINE_INITIAL_BLOCKS,
  timelineWindowStart,
} from "@/lib/timeline-window";
import { TimelineWindowContext, type TimelineWindowApi } from "./timeline-window-context.tsx";
import { matchTurnSnapshots, timelineTurns } from "@/lib/turn-undo";
import { useTurnSnapshots } from "../hooks/useTurnSnapshots.ts";
import { TurnUndoAction } from "./TurnUndoAction.tsx";
import { TurnPreviewAction } from "./TurnPreviewAction.tsx";
import { NextStepChips } from "./NextStepChips.tsx";
import { selectNextSteps, withoutNextTag } from "@/lib/next-steps";
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
  /** Render at most this many blocks from the end (long chats); default: all. */
  renderLimit?: number;
  /** Render one more step of earlier blocks. */
  onShowEarlier?: () => void;
  /** Filled with the ids of the rendered blocks (for minimap jumps). */
  renderedIdsRef?: MutableRefObject<Set<string>>;
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
  const [renderLimit, setRenderLimit] = useState(TIMELINE_INITIAL_BLOCKS);
  const renderedIdsRef = useRef(new Set<string>());
  // Each chat opens with its tail only.
  useEffect(() => setRenderLimit(TIMELINE_INITIAL_BLOCKS), [contentProps.sessionKey]);
  const showEarlier = useCallback(() => setRenderLimit((limit) => nextTimelineLimit(limit)), []);
  const windowApi = useMemo<TimelineWindowApi>(
    () => ({
      isRendered: (id) => renderedIdsRef.current.has(id),
      showAll: () => setRenderLimit(Number.POSITIVE_INFINITY),
    }),
    [],
  );

  return (
    <TimelineWindowContext.Provider value={windowApi}>
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
            <SessionTimelineContent
              {...contentProps}
              renderLimit={renderLimit}
              onShowEarlier={showEarlier}
              renderedIdsRef={renderedIdsRef}
            />
          </MessageScrollerViewport>
          {/* Sibling of the viewport, not a child: the rail must not scroll with the
           * transcript. It anchors to MessageScroller's relative box, and must stay
           * inside the provider for the message-scroller hooks to resolve. */}
          <ConversationMinimap items={contentProps.items} locale={contentProps.locale} />
        </MessageScroller>
      </MessageScrollerProvider>
    </TimelineWindowContext.Provider>
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
  // «Что дальше»: the model's <prsloy-next> tag becomes buttons, never text in the reply.
  const shownItems = useMemo(
    () =>
      items.map((item) =>
        item.kind === "assistant" ? { ...item, text: withoutNextTag(item.text) } : item,
      ),
    [items],
  );
  const nextSteps = useMemo(
    () => selectNextSteps(locale, items, running),
    [locale, items, running],
  );
  const blocks = useMemo(
    () => buildTimelineBlocks(developerMode ? shownItems : withoutRetryNoise(shownItems)),
    [shownItems, developerMode],
  );
  const start = timelineWindowStart(blocks.length, props.renderLimit ?? Number.POSITIVE_INFINITY);
  if (props.renderedIdsRef) {
    props.renderedIdsRef.current = new Set(
      blocks.slice(start).map((block) => (block.type === "process" ? block.id : block.item.id)),
    );
  }
  // Prepending earlier blocks keeps what the reader is looking at in place.
  const anchorRef = useRef<{ el: HTMLElement; height: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    anchorRef.current = null;
    anchor.el.scrollTop = anchor.top + (anchor.el.scrollHeight - anchor.height);
  }, [start]);
  const onShowEarlier = props.onShowEarlier;
  const showEarlier = useCallback(
    (from: HTMLElement | null) => {
      const el = from?.closest<HTMLElement>(".timeline-scroll");
      if (el) anchorRef.current = { el, height: el.scrollHeight, top: el.scrollTop };
      onShowEarlier?.();
    },
    [onShowEarlier],
  );
  const liveActivity = useMemo(
    () => deriveLiveActivity({ items, events, running, waiting }),
    [items, events, running, waiting],
  );
  const hasActivity = items.length > 0;
  /** Prompt of the turn being rendered, so a failure card can resend it. */
  let turnPrompt: string | undefined;
  for (let i = start - 1; i >= 0; i--) {
    const block = blocks[i]!;
    if (block.type === "item" && block.item.kind === "user") {
      turnPrompt = block.item.text;
      break;
    }
  }
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
          {start > 0 ? (
            <EarlierMessages hidden={start} locale={locale} onShow={showEarlier} />
          ) : null}
          {blocks.slice(start).map((block, offset) => {
            const index = start + offset;
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
          {nextSteps.length > 0 ? (
            <MessageScrollerItem
              messageId={`${sessionKey || "chat"}:next-steps`}
              scrollAnchor={false}
              className="w-full"
            >
              <NextStepChips locale={locale} steps={nextSteps} />
            </MessageScrollerItem>
          ) : null}
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

/**
 * «Показать предыдущие сообщения»: click, or scroll up to it. Scrolling only counts once
 * the reader has scrolled themselves — right after opening, the top of the list can be
 * on screen before the scroller has settled at the bottom.
 */
function EarlierMessages(props: {
  hidden: number;
  locale: Locale;
  onShow: (from: HTMLElement | null) => void;
}) {
  const { hidden, locale, onShow } = props;
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const el = ref.current;
    const root = el?.closest<HTMLElement>(".timeline-scroll");
    if (!el || !root || typeof IntersectionObserver === "undefined") return;
    let armed = false;
    const arm = () => {
      armed = true;
    };
    root.addEventListener("wheel", arm, { passive: true });
    root.addEventListener("touchmove", arm, { passive: true });
    root.addEventListener("keydown", arm);
    const observer = new IntersectionObserver(
      (entries) => {
        if (armed && entries.some((entry) => entry.isIntersecting)) onShow(el);
      },
      { root, rootMargin: "800px 0px 0px 0px" },
    );
    observer.observe(el);
    return () => {
      observer.disconnect();
      root.removeEventListener("wheel", arm);
      root.removeEventListener("touchmove", arm);
      root.removeEventListener("keydown", arm);
    };
  }, [onShow, hidden]);
  return (
    <button
      ref={ref}
      type="button"
      data-testid="timeline-show-earlier"
      className="mx-auto mb-4 rounded-full px-3 py-1 text-[12px] text-[var(--muted-foreground)] hover:bg-[var(--muted)]"
      onClick={() => onShow(ref.current)}
    >
      {t(locale, "timeline.showEarlier", { count: String(hidden) })}
    </button>
  );
}
