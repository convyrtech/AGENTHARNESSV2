import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTimelineWindow } from "./timeline-window-context.tsx";
import {
  useMessageScroller,
  useMessageScrollerScrollable,
  useMessageScrollerVisibility,
} from "@/components/ui/message-scroller";
import {
  buildConversationMinimapMarkers,
  shouldRenderConversationMinimap,
  type ConversationMinimapMarker,
} from "@/lib/conversation-minimap";
import { t, type Locale } from "@/lib/i18n";
import type { TimelineItem } from "@/lib/timeline";

/* Codex-style conversation minimap: a packed stack of dashes on the left edge of the
 * thread, one per user turn or assistant response. Moving the cursor along the rail
 * magnifies nearby dashes with a macOS-Dock cosine falloff, the nearest turn shows a
 * preview popover, and clicking jumps to that turn. Dashes grow horizontally only, so
 * magnification never shifts the stack layout.
 *
 * Unlike the original, scroll position is not measured here: @shadcn/react's
 * message-scroller owns the scroller and already exposes jump-to-message, overflow, and
 * visibility. Only the rail-local dash geometry is measured, and only because
 * magnification needs it. */

/* Dock magnification: reach of the falloff and peak growth factor. */
const MAGNIFY_RADIUS = 46;
const MAGNIFY_BOOST = 1.3;
/* Cursor must be this close to a dash for the popover to pick it. */
const POPOVER_SNAP = 24;
const POPOVER_HEIGHT = 132;

/** Pixel offset left above a jumped-to row so it does not sit flush against the top. */
const JUMP_SCROLL_MARGIN = 24;

export const ConversationMinimap = memo(function ConversationMinimap({
  items,
  locale,
}: {
  items: TimelineItem[];
  locale: Locale;
}) {
  const { scrollToMessage } = useMessageScroller();
  const timelineWindow = useTimelineWindow();
  const scrollable = useMessageScrollerScrollable();
  const { visibleMessageIds } = useMessageScrollerVisibility();

  const [hovered, setHovered] = useState<{
    marker: ConversationMinimapMarker;
    top: number;
  } | null>(null);
  const [scrollHints, setScrollHints] = useState({ up: false, down: false });
  const railRef = useRef<HTMLElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const markerEls = useRef(new Map<string, HTMLButtonElement>());
  const moveRaf = useRef(0);

  const markers = useMemo(() => buildConversationMinimapMarkers(items), [items]);
  const markersRef = useRef(markers);
  markersRef.current = markers;

  /* Ids, not contents: streamed tokens must not invalidate the effects below. */
  const markerIdentity = useMemo(
    () => markers.map((marker) => marker.id).join("\u0000"),
    [markers],
  );

  const overflows = scrollable.start || scrollable.end;

  /* The scroller marks no item as its scroll anchor (`scrollAnchor={false}` throughout),
   * so `currentAnchorId` stays null. Lead the highlight off whichever markers are
   * actually on screen instead. */
  const activeId = useMemo(() => {
    const ids = new Set(markers.map((marker) => marker.id));
    return visibleMessageIds.find((id) => ids.has(id)) ?? null;
  }, [markers, visibleMessageIds]);

  /**
   * Vertical centers of the dashes, in rail-local pixels.
   *
   * Rows have a CSS-fixed height and magnify horizontally only, so their centers
   * follow the rail's layout, not the cursor. Measuring them once per layout keeps hover
   * off the critical path: `applyMagnify` runs on every mousemove frame, and reading
   * `offsetTop` there — interleaved with the `--magnify` writes it makes in the same loop
   * — would force a synchronous reflow per dash.
   */
  const magnifyCentersRef = useRef<{ id: string; center: number }[]>([]);

  const measureMagnifyCenters = useCallback(() => {
    const centers: { id: string; center: number }[] = [];
    const scrollTop = trackRef.current?.scrollTop ?? 0;
    // Read-only pass: no style writes, so layout is computed at most once.
    for (const [id, btn] of markerEls.current) {
      centers.push({ id, center: btn.offsetTop + btn.offsetHeight / 2 - scrollTop });
    }
    centers.sort((a, b) => a.center - b.center);
    magnifyCentersRef.current = centers;
  }, []);

  const updateScrollHints = useCallback(() => {
    const track = trackRef.current;
    if (!track) return;
    const next = {
      up: track.scrollTop > 1,
      down: track.scrollTop + track.clientHeight < track.scrollHeight - 1,
    };
    setScrollHints((prev) => (prev.up === next.up && prev.down === next.down ? prev : next));
  }, []);

  const keepActiveMarkerVisible = useCallback(() => {
    const track = trackRef.current;
    const active = activeId ? markerEls.current.get(activeId) : null;
    if (!track || !active) return;
    const top = active.offsetTop;
    const height = active.offsetHeight;
    const viewportHeight = track.clientHeight;
    // Reserve the 12px hint bands when there is room; on a short rail, shrink the
    // effective insets so a 24px row still fits. If it cannot fit, center it as well as
    // the viewport allows. Clamp against the browser's actual scroll range at both ends.
    const inset = Math.min(12, Math.max(0, (viewportHeight - height) / 2));
    const visibleTop = track.scrollTop + inset;
    const visibleBottom = track.scrollTop + viewportHeight - inset;
    let nextScrollTop = track.scrollTop;
    if (viewportHeight < height) {
      nextScrollTop = top + height / 2 - viewportHeight / 2;
    } else if (top < visibleTop) {
      nextScrollTop = top - inset;
    } else if (top + height > visibleBottom) {
      nextScrollTop = top + height - viewportHeight + inset;
    }
    const maxScrollTop = Math.max(0, track.scrollHeight - viewportHeight);
    track.scrollTop = Math.max(0, Math.min(maxScrollTop, nextScrollTop));
  }, [activeId]);

  const jumpTo = useCallback(
    (id: string) => {
      const scroll = () =>
        scrollToMessage(id, {
          align: "start",
          behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
            ? "auto"
            : "smooth",
          scrollMargin: JUMP_SCROLL_MARGIN,
        });
      if (timelineWindow.isRendered(id)) {
        scroll();
        return;
      }
      // A long chat renders its tail only: bring the rest in, then jump once it is laid out.
      timelineWindow.showAll();
      requestAnimationFrame(() => requestAnimationFrame(scroll));
    },
    [scrollToMessage, timelineWindow],
  );

  /* Dock magnification, applied imperatively so mousemove never re-renders. */
  const applyMagnify = useCallback(
    (cursorY: number | null) => {
      if (magnifyCentersRef.current.length === 0) {
        // Nothing measured yet (first frame after mount): measure rather than skip the
        // effect the user asked for.
        measureMagnifyCenters();
      }
      let nearest: { id: string; dist: number; center: number } | null = null;
      for (const { id, center } of magnifyCentersRef.current) {
        const btn = markerEls.current.get(id);
        if (!btn) continue;
        let scale = 1;
        if (cursorY != null) {
          const dist = Math.abs(center - cursorY);
          if (dist < MAGNIFY_RADIUS) {
            scale = 1 + MAGNIFY_BOOST * Math.cos((dist / MAGNIFY_RADIUS) * (Math.PI / 2));
          }
          if (dist <= POPOVER_SNAP && (!nearest || dist < nearest.dist)) {
            nearest = { id, dist, center };
          }
        }
        btn.style.setProperty("--magnify", scale.toFixed(3));
      }
      if (nearest) {
        const marker = markersRef.current.find((m) => m.id === nearest!.id);
        const rail = railRef.current;
        if (marker && rail) {
          const top = Math.min(
            Math.max(nearest.center - 36, 0),
            Math.max(rail.clientHeight - POPOVER_HEIGHT, 0),
          );
          setHovered((prev) =>
            prev?.marker.id === marker.id && prev.top === top ? prev : { marker, top },
          );
          return;
        }
      }
      setHovered(null);
    },
    [measureMagnifyCenters],
  );

  const handleMouseMove = useCallback(
    (event: React.MouseEvent) => {
      const rail = railRef.current;
      if (!rail) return;
      const y = event.clientY - rail.getBoundingClientRect().top;
      cancelAnimationFrame(moveRaf.current);
      moveRaf.current = requestAnimationFrame(() => applyMagnify(y));
    },
    [applyMagnify],
  );

  const handleMouseLeave = useCallback(() => {
    cancelAnimationFrame(moveRaf.current);
    applyMagnify(null);
  }, [applyMagnify]);

  useEffect(() => () => cancelAnimationFrame(moveRaf.current), []);

  /* Row centers follow the rail's own box and scroll position. Observing the rail catches
   * pane-height changes, and the track's scroll handler catches its position changes. */
  useEffect(() => {
    measureMagnifyCenters();
    updateScrollHints();
    const rail = railRef.current;
    if (!rail || typeof ResizeObserver === "undefined") return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        keepActiveMarkerVisible();
        measureMagnifyCenters();
        updateScrollHints();
      });
    });
    observer.observe(rail);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
    // `overflows` gates whether the rail is mounted at all, so the observer has to be
    // reattached when it returns.
  }, [
    keepActiveMarkerVisible,
    markerIdentity,
    measureMagnifyCenters,
    overflows,
    updateScrollHints,
  ]);

  /* Keep the active row visible. The rail reserves hint space permanently, so adding or
   * removing the scroll indicators never shifts marker geometry. */
  useLayoutEffect(() => {
    keepActiveMarkerVisible();
    measureMagnifyCenters();
    updateScrollHints();
  }, [activeId, keepActiveMarkerVisible, markerIdentity, measureMagnifyCenters, updateScrollHints]);

  const handleTrackScroll = useCallback(() => {
    cancelAnimationFrame(moveRaf.current);
    moveRaf.current = requestAnimationFrame(measureMagnifyCenters);
    updateScrollHints();
    setHovered(null);
  }, [measureMagnifyCenters, updateScrollHints]);

  if (!shouldRenderConversationMinimap({ markerCount: markers.length, overflows })) {
    return null;
  }

  const roleLabel = (role: ConversationMinimapMarker["role"]) =>
    role === "user" ? t(locale, "timeline.minimapUser") : t(locale, "timeline.minimapAssistant");

  return (
    <nav
      className="minimap-rail"
      ref={railRef}
      aria-label={t(locale, "timeline.minimap")}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
    >
      <div className="minimap-track" ref={trackRef} onScroll={handleTrackScroll}>
        {markers.map((marker) => (
          <button
            key={marker.id}
            type="button"
            ref={(node) => {
              if (node) markerEls.current.set(marker.id, node);
              else markerEls.current.delete(marker.id);
            }}
            className={`minimap-marker ${marker.role} ${marker.id === activeId ? "active" : ""}`}
            aria-label={roleLabel(marker.role)}
            aria-current={marker.id === activeId ? "true" : undefined}
            onFocus={(event) => {
              const rail = railRef.current;
              const top = rail
                ? event.currentTarget.getBoundingClientRect().top -
                  rail.getBoundingClientRect().top -
                  36
                : 0;
              setHovered({ marker, top: Math.max(0, top) });
            }}
            onBlur={() => setHovered(null)}
            onClick={() => jumpTo(marker.id)}
          />
        ))}
      </div>
      {scrollHints.up ? (
        <span className="minimap-scroll-hint up" aria-hidden="true">
          ⌃
        </span>
      ) : null}
      {scrollHints.down ? (
        <span className="minimap-scroll-hint down" aria-hidden="true">
          ⌄
        </span>
      ) : null}
      {hovered && hovered.marker.preview ? (
        <div className="minimap-popover" role="tooltip" style={{ top: `${hovered.top}px` }}>
          <div className="minimap-popover-role">{roleLabel(hovered.marker.role)}</div>
          <div className="minimap-popover-text">{hovered.marker.preview}</div>
        </div>
      ) : null}
    </nav>
  );
});
