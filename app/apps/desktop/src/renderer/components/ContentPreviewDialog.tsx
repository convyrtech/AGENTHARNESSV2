import { useEffect, useState, type ReactEventHandler, type ReactNode } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { t, type Locale } from "../lib/i18n.ts";
import { cn } from "../lib/utils.ts";

/**
 * Full-screen content preview (expanded table / image).
 *
 * Close button sits at the top-right of the content card (not the viewport),
 * so it moves with the table and is always within reach.
 */
export function ContentPreviewDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  closeLabel: string;
  children: ReactNode;
  className?: string | undefined;
  testId?: string | undefined;
}) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className={cn(
          "content-preview-dialog top-0 left-0 max-w-none translate-x-0 translate-y-0 data-[state=closed]:zoom-out-100 data-[state=open]:zoom-in-100 sm:max-w-none",
          props.className,
        )}
        aria-label={props.title}
        data-testid={props.testId}
        // Keep focus on the dialog shell; don't move focus into table cells on open.
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <DialogTitle className="sr-only">{props.title}</DialogTitle>
        <div className="content-preview-dialog-stage">
          <div className="content-preview-dialog-card">
            {props.children}
            <button
              type="button"
              className="content-preview-dialog-close"
              aria-label={props.closeLabel}
              title={props.closeLabel}
              data-testid="content-preview-close"
              onClick={() => props.onOpenChange(false)}
            />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function ImagePreviewDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  source: string;
  /**
   * Local file path of the picture. When given, the dialog loads the full-size image itself
   * instead of upscaling the composer thumbnail (#74); `source` stays the instant fallback so
   * the dialog never opens empty.
   */
  path?: string | undefined;
  alt?: string | undefined;
  locale: Locale;
  onError?: ReactEventHandler<HTMLImageElement> | undefined;
}) {
  const title = props.alt || t(props.locale, "timeline.imagePreview");
  // Key the answer by path: while another picture loads, its predecessor must never flash.
  const [fullSize, setFullSize] = useState<{ path: string; url: string }>();
  const imagePath = props.path;
  useEffect(() => {
    setFullSize(undefined);
    if (!props.open || !imagePath) return;
    let cancelled = false;
    void window.zeno?.workspace
      ?.readAttachmentImage?.(imagePath)
      .then((url) => {
        if (!cancelled && url) setFullSize({ path: imagePath, url });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [props.open, imagePath]);

  // The dialog card shrink-wraps its content (that is right for tables), so an image needs its
  // own box size here — otherwise the stage collapses and a thumbnail lands at ~100×100 (#74).
  return (
    <ContentPreviewDialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      title={title}
      closeLabel={t(props.locale, "timeline.imagePreviewClose")}
      className="content-image-preview-dialog"
      testId="image-preview-dialog"
    >
      <div className="content-image-preview-surface">
        <img
          src={fullSize && fullSize.path === imagePath ? fullSize.url : props.source}
          alt={props.alt ?? ""}
          className="content-image-preview-image"
          onError={props.onError}
        />
      </div>
    </ContentPreviewDialog>
  );
}
