import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
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
    center: number;
    top: number;
  } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const railRef = useRef<HTMLElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const popoverHeightRef = useRef(0);
  const sliderRef = useRef<HTMLInputElement>(null);
  const markerEls = useRef(new Map<string, HTMLSpanElement>());
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

  const preferredIndex = markers.findIndex((marker) => marker.id === selectedId);
  const activeIndex = markers.findIndex((marker) => marker.id === activeId);
  const selectedIndex = preferredIndex >= 0 ? preferredIndex : Math.max(activeIndex, 0);
  const selectedMarker = markers[selectedIndex];

  /**
   * Vertical centers of the dashes, in rail-local pixels.
   *
   * Dashes have a CSS-fixed height and magnify horizontally only, so their centers
   * follow the rail's layout, not the cursor. Measuring them once per layout keeps hover
   * off the critical path: `applyMagnify` runs on every mousemove frame, and reading
   * `offsetTop` there — interleaved with the `--magnify` writes it makes in the same loop
   * — would force a synchronous reflow per dash.
   */
  const magnifyCentersRef = useRef<{ id: string; center: number }[]>([]);

  const measureMagnifyCenters = useCallback(() => {
    const centers: { id: string; center: number }[] = [];
    // Read-only pass: no style writes, so layout is computed at most once.
    const railTop = railRef.current?.getBoundingClientRect().top ?? 0;
    for (const [id, marker] of markerEls.current) {
      const rect = marker.getBoundingClientRect();
      centers.push({ id, center: rect.top - railTop + rect.height / 2 });
    }
    centers.sort((a, b) => a.center - b.center);
    magnifyCentersRef.current = centers;
  }, []);

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

  const popoverTop = useCallback(
    (center: number, railHeight: number) =>
      Math.min(Math.max(center - 36, 0), Math.max(railHeight - popoverHeightRef.current, 0)),
    [],
  );

  const selectMarker = useCallback(
    (index: number) => {
      const marker = markersRef.current[index];
      if (!marker) return;
      setSelectedId(marker.id);
      jumpTo(marker.id);
      const rail = railRef.current;
      const center = magnifyCentersRef.current.find((entry) => entry.id === marker.id)?.center;
      if (rail && center != null) {
        setHovered({ marker, center, top: popoverTop(center, rail.clientHeight) });
      }
    },
    [jumpTo, popoverTop],
  );

  useLayoutEffect(() => {
    const popover = popoverRef.current;
    const rail = railRef.current;
    if (!popover || !rail) return;
    const height = popover.getBoundingClientRect().height;
    if (height <= 0) return;
    popoverHeightRef.current = height;
    setHovered((prev) => {
      if (!prev) return prev;
      const top = popoverTop(prev.center, rail.clientHeight);
      return prev.top === top ? prev : { ...prev, top };
    });
  }, [hovered?.marker.id, hovered?.marker.preview, hovered?.center, popoverTop]);

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
        const markerElement = markerEls.current.get(id);
        if (!markerElement) continue;
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
        markerElement.style.setProperty("--magnify", scale.toFixed(3));
      }
      if (nearest) {
        const marker = markersRef.current.find((m) => m.id === nearest!.id);
        const rail = railRef.current;
        if (marker && rail) {
          const top = popoverTop(nearest.center, rail.clientHeight);
          setHovered((prev) =>
            prev?.marker.id === marker.id && prev.top === top && prev.center === nearest.center
              ? prev
              : { marker, center: nearest.center, top },
          );
          return;
        }
      }
      setHovered(null);
    },
    [measureMagnifyCenters, popoverTop],
  );

  const handleChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      selectMarker(Number(event.currentTarget.value));
    },
    [selectMarker],
  );

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLInputElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.focus({ preventScroll: true });
      const rail = railRef.current;
      if (!rail) return;
      const centers = magnifyCentersRef.current;
      if (centers.length === 0) measureMagnifyCenters();
      const measured = magnifyCentersRef.current;
      if (measured.length === 0) return;
      const first = measured[0]!.center;
      const last = measured[measured.length - 1]!.center;
      const y = event.clientY - rail.getBoundingClientRect().top;
      const position =
        last === first
          ? (y / Math.max(rail.clientHeight, 1)) * (measured.length - 1)
          : ((y - first) / (last - first)) * (measured.length - 1);
      selectMarker(Math.max(0, Math.min(measured.length - 1, Math.round(position))));
    },
    [measureMagnifyCenters, selectMarker],
  );

  const handleSliderBlur = useCallback(() => {
    setSelectedId(null);
    setHovered(null);
  }, []);

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

  /* Dash centers follow the rail's own box, which is driven by the pane height and by the
   * marker-count-dependent gap — not by the marker set alone. Observing the rail catches
   * every cause, so magnification never tracks stale positions. */
  useEffect(() => {
    measureMagnifyCenters();
    const rail = railRef.current;
    if (!rail || typeof ResizeObserver === "undefined") return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        measureMagnifyCenters();
        const popoverHeight = popoverRef.current?.getBoundingClientRect().height;
        if (popoverHeight && popoverHeight > 0) popoverHeightRef.current = popoverHeight;
        setHovered((prev) => {
          if (!prev) return prev;
          const measured = magnifyCentersRef.current.find(({ id }) => id === prev.marker.id);
          if (!measured) return null;
          const center = measured.center;
          const top = popoverTop(center, rail.clientHeight);
          return prev.top === top && prev.center === center ? prev : { ...prev, center, top };
        });
      });
    });
    observer.observe(rail);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
    // `overflows` gates whether the rail is mounted at all, so the observer has to be
    // reattached when it returns.
  }, [markerIdentity, measureMagnifyCenters, overflows, popoverTop]);

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
      style={{ "--minimap-marker-count": markers.length } as CSSProperties}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
    >
      <input
        ref={sliderRef}
        className="minimap-slider"
        type="range"
        min={0}
        max={markers.length - 1}
        step={1}
        value={selectedIndex}
        aria-label={t(locale, "timeline.minimap")}
        aria-valuetext={
          selectedMarker
            ? `${roleLabel(selectedMarker.role)}, ${selectedIndex + 1} / ${markers.length}${selectedMarker.preview ? `, ${selectedMarker.preview.slice(0, 80)}` : ""}`
            : undefined
        }
        onChange={handleChange}
        onPointerDown={handlePointerDown}
        onBlur={handleSliderBlur}
      />
      {markers.map((marker) => (
        <span
          key={marker.id}
          ref={(node) => {
            if (node) markerEls.current.set(marker.id, node);
            else markerEls.current.delete(marker.id);
          }}
          className={`minimap-marker ${marker.role} ${marker.id === activeId ? "active" : ""} ${marker.id === selectedId ? "selected" : ""} ${marker.id === hovered?.marker.id ? "hovered" : ""}`}
        />
      ))}
      {hovered && hovered.marker.preview ? (
        <div
          ref={popoverRef}
          className="minimap-popover"
          role="tooltip"
          style={{ top: `${hovered.top}px` }}
        >
          <div className="minimap-popover-role">{roleLabel(hovered.marker.role)}</div>
          <div className="minimap-popover-text">{hovered.marker.preview}</div>
        </div>
      ) : null}
    </nav>
  );
});
