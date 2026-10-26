/**
 * Sandboxed page preview with a «Компьютер / Телефон» switch, shared by the «Дизайн» tab
 * and the «Код» side panel. The frame gets no preload and no IPC (main accepts IPC from the
 * main frame only), and main holds every subframe to loopback preview origins.
 */
import { useEffect, useRef } from "react";
import { t, type Locale } from "../lib/i18n.ts";
import { type BridgeMessage, parseBridgeMessage, pickCommand } from "../lib/preview-bridge.ts";
import { cn } from "../lib/utils.ts";

export type PreviewDevice = "desktop" | "phone";

export function PreviewDeviceSwitch(props: {
  locale: Locale;
  device: PreviewDevice;
  onChange: (device: PreviewDevice) => void;
  /** `design` keeps the «Дизайн» tab's test ids. */
  testIdPrefix: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={t(props.locale, "design.preview")}
      className="model-tier-switch"
      data-testid={`${props.testIdPrefix}-device`}
    >
      {(["desktop", "phone"] as const).map((d) => (
        <button
          key={d}
          type="button"
          role="radio"
          aria-checked={props.device === d}
          data-active={props.device === d ? "true" : "false"}
          data-testid={`${props.testIdPrefix}-device-${d}`}
          className="model-tier-option"
          onClick={() => props.onChange(d)}
        >
          {t(props.locale, d === "desktop" ? "design.device.desktop" : "design.device.phone")}
        </button>
      ))}
    </div>
  );
}

/**
 * Talk with the script a preview server injects (`main/preview-bridge`, the `inject` option of
 * `startPreviewServer`). A message counts only when it comes from this frame's window and
 * from the preview's origin: the page's own (127.0.0.1:<port>) when the sandbox allows
 * same-origin («Код»), else the opaque "null" of a scripts-only sandbox («Дизайн»), where
 * the window check is what holds. Pages without the script never say `ready`, so the caller
 * shows no bridge controls for them.
 */
export type PreviewBridge = {
  picking: boolean;
  onMessage: (message: BridgeMessage) => void;
};

function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

export function PreviewStage(props: {
  locale: Locale;
  url: string;
  device: PreviewDevice;
  testId: string;
  /**
   * The design preview runs scripts only. A «Код» page may also keep its own storage and
   * submit forms: its origin (127.0.0.1:<port>) is never the app's, and main guards where
   * the frame can navigate.
   */
  sandbox?: string;
  className?: string;
  bridge?: PreviewBridge;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const hasBridge = props.bridge !== undefined;
  const onMessage = useRef(props.bridge?.onMessage);
  onMessage.current = props.bridge?.onMessage;
  const picking = useRef(props.bridge?.picking ?? false);
  picking.current = props.bridge?.picking ?? false;
  /**
   * The page in the frame said «ready». Until then a pick command is not sent: «ready» sends the
   * current state. Sending on mount as well armed picking twice, and the second «on» could land after
   * the owner had already picked — the next double click then picked again instead of editing text.
   */
  const ready = useRef(false);
  const sameOrigin = (props.sandbox ?? "allow-scripts").split(/\s+/u).includes("allow-same-origin");
  const pageOrigin = originOf(props.url);
  /** What `event.origin` must be. */
  const origin = pageOrigin && (sameOrigin ? pageOrigin : "null");
  /** Where commands go: an opaque frame has no origin to name, its window is the target. */
  const target = sameOrigin ? pageOrigin : "*";

  useEffect(() => {
    if (!hasBridge || !origin) return;
    const listener = (event: MessageEvent) => {
      const frame = frameRef.current?.contentWindow;
      if (!frame || event.source !== frame || event.origin !== origin) return;
      const message = parseBridgeMessage(event.data);
      if (!message) return;
      // A page the frame moved to starts with picking off: repeat the owner's choice, once.
      if (message.type === "ready") {
        ready.current = true;
        if (picking.current) frame.postMessage(pickCommand(true), target ?? "*");
      }
      onMessage.current?.(message);
    };
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, [hasBridge, origin, target]);

  // A new page: wait for its «ready» again.
  useEffect(() => {
    ready.current = false;
  }, [props.url]);

  const pickingNow = props.bridge?.picking ?? false;
  useEffect(() => {
    if (!hasBridge || !origin || !ready.current) return;
    frameRef.current?.contentWindow?.postMessage(pickCommand(pickingNow), target ?? "*");
  }, [hasBridge, origin, target, pickingNow]);

  return (
    <div className={cn("design-preview-stage", props.className)} data-device={props.device}>
      <iframe
        ref={frameRef}
        src={props.url}
        title={t(props.locale, "design.preview")}
        sandbox={props.sandbox ?? "allow-scripts"}
        referrerPolicy="no-referrer"
        className="design-preview-frame"
        data-testid={props.testId}
      />
    </div>
  );
}
