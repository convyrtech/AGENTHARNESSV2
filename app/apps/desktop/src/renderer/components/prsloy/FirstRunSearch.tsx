/**
 * First-run step «search» between the chats from other agents and the folder (#23): one question —
 * may the agent look things up on the web? «Включить поиск» turns the harness flag `webTools` on (the
 * free search, no key); «Не сейчас» writes it off — the default may be on (RC check), so the answer is
 * always saved. Keys and other searches stay in Settings → «Поиск в
 * интернете». The Gate draws the card and remembers that the step was seen.
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";
import { errorText } from "@/lib/memory";
import type { FirstRunStepProps } from "@/lib/prsloy-first-run";

export function FirstRunSearch({ locale, onDone }: FirstRunStepProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function choose(webTools: boolean) {
    setBusy(true);
    setError(undefined);
    try {
      await window.zeno.harnessFlags.set({ webTools });
      onDone();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }

  return (
    <div className="prsloy-first-run-form" data-testid="first-run-search">
      <h1 className="prsloy-first-run-title">{t(locale, "features.web.firstRun.title")}</h1>
      <p className="prsloy-first-run-note">{t(locale, "features.web.firstRun.note")}</p>
      {error ? (
        <p role="alert" className="prsloy-first-run-error">
          {t(locale, "features.web.failed", { error })}
        </p>
      ) : null}
      <Button
        className="h-10"
        data-testid="first-run-search-on"
        data-first-run-primary
        disabled={busy}
        onClick={() => void choose(true)}
      >
        {t(locale, "features.web.firstRun.on")}
      </Button>
      <button
        type="button"
        className="prsloy-first-run-link prsloy-first-run-link-quiet"
        data-testid="first-run-search-skip"
        disabled={busy}
        onClick={() => void choose(false)}
      >
        {t(locale, "features.web.firstRun.skip")}
      </button>
      <p className="prsloy-first-run-note">{t(locale, "features.web.firstRun.later")}</p>
    </div>
  );
}
