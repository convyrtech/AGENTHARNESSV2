/**
 * «Настроить» under the built page: the brand's variables as a few handles, no model.
 * Colours come from the brand's own swatches; sizes move within 0.5–2× of the page's value.
 * Moving a handle shows it in the preview (main injects the values); «Сохранить» writes the files.
 */
import type { DesignToken, DesignTokenLabel } from "@zeno/contracts";
import { Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { unwrapRemoteIpcError } from "../../../shared/ipc-error.ts";
import type { MessageKey } from "../../lib/i18n.ts";
import { Button } from "../ui/button.tsx";

const LABELS: Record<DesignTokenLabel, MessageKey> = {
  background: "design.tweak.background",
  text: "design.tweak.text",
  accent: "design.tweak.accent",
  radius: "design.tweak.radius",
  size: "design.tweak.size",
  spacing: "design.tweak.spacing",
};
const LENGTH = /^(\d+(?:\.\d+)?)(px|rem|em)$/;

function lengthOf(value: string): { n: number; unit: string } {
  const m = LENGTH.exec(value);
  return m ? { n: Number(m[1]), unit: m[2]! } : { n: 0, unit: "px" };
}

function fmt(n: number, unit: string): string {
  return unit === "px" ? `${Math.round(n)}px` : `${Math.round(n * 100) / 100}${unit}`;
}

function errorText(e: unknown): string {
  return unwrapRemoteIpcError(e instanceof Error ? e.message : String(e));
}

export function TokenPanel({
  projectPath,
  tr,
  onPreview,
  onClose,
}: {
  projectPath: string | undefined;
  tr: (key: MessageKey) => string;
  /** The preview should reload: new values are shown (or dropped). */
  onPreview: () => void;
  onClose: () => void;
}) {
  const api = window.zeno.design;
  const [tokens, setTokens] = useState<DesignToken[]>();
  const [swatches, setSwatches] = useState<string[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<"save" | "cancel">();
  const [error, setError] = useState<string>();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    let alive = true;
    void api
      .tokens(projectPath)
      .then((r) => {
        if (!alive) return;
        setTokens(r.tokens);
        setSwatches(r.swatches);
        setValues(Object.fromEntries(r.tokens.map((t) => [t.name, t.value])));
      })
      .catch((e) => alive && (setTokens([]), setError(errorText(e))));
    return () => {
      alive = false;
      clearTimeout(timer.current);
    };
  }, [api, projectPath]);

  const changed = (vals: Record<string, string>) =>
    Object.fromEntries(
      (tokens ?? []).filter((t) => vals[t.name] !== t.value).map((t) => [t.name, vals[t.name]!]),
    );

  const set = (name: string, value: string) => {
    const next = { ...values, [name]: value };
    setValues(next);
    clearTimeout(timer.current);
    // a slider fires on every pixel: show the values once it rests
    timer.current = setTimeout(() => {
      void api
        .previewTokens(projectPath, changed(next))
        .then((r) => {
          setError(r.ok ? undefined : r.error);
          if (r.ok) onPreview();
        })
        .catch((e) => setError(errorText(e)));
    }, 200);
  };

  const finish = async (save: boolean) => {
    clearTimeout(timer.current);
    setBusy(save ? "save" : "cancel");
    try {
      const r = save
        ? await api.saveTokens(projectPath, changed(values))
        : await api.previewTokens(projectPath, null);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      onPreview();
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(undefined);
    }
  };

  if (!tokens) return null;
  if (tokens.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="design-tweak-none">
        {tr("design.tweak.none")}
      </p>
    );
  }
  const dirty = Object.keys(changed(values)).length > 0;
  return (
    <div className="flex flex-col gap-3 rounded-lg border p-3" data-testid="design-tweak">
      {tokens.map((t) =>
        t.kind === "color" ? (
          <div
            key={t.name}
            className="flex flex-wrap items-center gap-2"
            data-testid={`design-tweak-${t.label}`}
          >
            <span className="w-32 text-sm">{tr(LABELS[t.label])}</span>
            {swatches.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={c}
                aria-pressed={values[t.name]?.toLowerCase() === c}
                data-testid={`design-tweak-${t.label}-${c.slice(1)}`}
                className="size-6 rounded-full border aria-pressed:ring-2 aria-pressed:ring-ring"
                style={{ background: c }}
                onClick={() => set(t.name, c)}
              />
            ))}
          </div>
        ) : (
          <label
            key={t.name}
            className="flex items-center gap-2"
            data-testid={`design-tweak-${t.label}`}
          >
            <span className="w-32 text-sm">{tr(LABELS[t.label])}</span>
            <input
              type="range"
              className="flex-1 accent-primary"
              min={lengthOf(t.value).n * 0.5}
              max={lengthOf(t.value).n * 2}
              step={lengthOf(t.value).unit === "px" ? 1 : 0.025}
              value={lengthOf(values[t.name] ?? t.value).n}
              data-testid={`design-tweak-${t.label}-range`}
              onChange={(e) => set(t.name, fmt(Number(e.target.value), lengthOf(t.value).unit))}
            />
            <span className="w-16 text-right text-sm tabular-nums text-muted-foreground">
              {values[t.name]}
            </span>
          </label>
        ),
      )}
      {error ? (
        <p className="text-sm text-destructive" role="alert" data-testid="design-tweak-error">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button
          variant="ghost"
          size="sm"
          disabled={busy !== undefined}
          data-testid="design-tweak-cancel"
          onClick={() => void finish(false)}
        >
          {busy === "cancel" ? <Loader2 className="animate-spin" /> : null}
          {tr("design.tweak.cancel")}
        </Button>
        <Button
          size="sm"
          disabled={!dirty || busy !== undefined || error !== undefined}
          data-testid="design-tweak-save"
          onClick={() => void finish(true)}
        >
          {busy === "save" ? <Loader2 className="animate-spin" /> : null}
          {tr("design.tweak.save")}
        </Button>
      </div>
    </div>
  );
}
