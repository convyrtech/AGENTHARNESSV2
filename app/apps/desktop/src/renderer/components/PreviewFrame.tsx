/**
 * Sandboxed page preview with a «Компьютер / Телефон» switch, shared by the «Дизайн» tab
 * and the «Код» side panel. The frame gets no preload and no IPC (main accepts IPC from the
 * main frame only), and main holds every subframe to loopback preview origins.
 */
import { t, type Locale } from "../lib/i18n.ts";
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
}) {
  return (
    <div className={cn("design-preview-stage", props.className)} data-device={props.device}>
      <iframe
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
