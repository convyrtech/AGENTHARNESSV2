/**
 * General → «Чаты из других программ» (#22 I1): the first-run import panel, on demand. Nothing
 * is scanned until «Найти чаты».
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ImportChats } from "@/components/prsloy/ImportChats";
import type { MessageKey } from "../../lib/i18n.ts";
import { useShellStore } from "../../store/shell-store.ts";
import { SettingsRow, SettingsSectionBlock } from "./SettingsPrimitives.tsx";

export function ImportChatsBlock(props: { tr: (key: MessageKey) => string }) {
  const { tr } = props;
  const locale = useShellStore((s) => s.locale);
  const [open, setOpen] = useState(false);
  return (
    <SettingsSectionBlock label={tr("prsloy.import.settingsTitle")} testId="settings-import">
      <SettingsRow
        title={tr("prsloy.import.settingsTitle")}
        description={tr("prsloy.import.settingsHint")}
        control={
          open ? null : (
            <Button
              variant="outline"
              size="sm"
              data-testid="settings-import-find"
              onClick={() => setOpen(true)}
            >
              {tr("prsloy.import.find")}
            </Button>
          )
        }
        last={!open}
      />
      {open ? (
        <div className="settings-import-panel">
          <ImportChats locale={locale} mode="settings" onDone={() => setOpen(false)} />
        </div>
      ) : null}
    </SettingsSectionBlock>
  );
}
