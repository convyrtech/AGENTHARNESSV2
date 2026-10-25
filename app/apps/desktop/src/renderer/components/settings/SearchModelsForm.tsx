/**
 * «Поиск модели» → «Изменить модели» (issue #23): the models whose built-in search is tried, in order —
 * move one up, remove one, add one from the gateway's catalog. Never empty, at most ten (design's
 * `setModels`).
 */
import { ArrowUp, X } from "lucide-react";
import { useState } from "react";
import type { MessageKey } from "../../lib/i18n.ts";
import {
  MAX_SEARCH_MODELS,
  moveUp,
  SEARCH_MODEL_CATALOG,
  searchModelName,
} from "../../lib/search-settings.ts";
import { SettingsButton, SettingsIconButton, SettingsSelect } from "./SettingsPrimitives.tsx";

export function SearchModelsForm(props: {
  tr: (key: MessageKey, vars?: Record<string, string>) => string;
  models: readonly string[];
  busy: boolean;
  onSave: (models: string[]) => void;
  onCancel: () => void;
}) {
  const { tr } = props;
  const [list, setList] = useState<string[]>([...props.models]);
  const rest = SEARCH_MODEL_CATALOG.filter((model) => !list.includes(model.id));
  return (
    <span className="web-search-models" data-testid="web-search-models-form">
      <span className="web-search-models-list">
        {list.map((id, index) => {
          const name = searchModelName(id);
          return (
            <span key={id} className="web-search-model" data-testid="web-search-model-item">
              <span className="web-search-model-name">
                {index + 1}. {name}
              </span>
              <SettingsIconButton
                testId="web-search-model-up"
                aria-label={tr("features.web.modelsUp", { name })}
                disabled={props.busy || index === 0}
                onClick={() => setList(moveUp(list, index))}
              >
                <ArrowUp className="size-3.5" strokeWidth={1.75} />
              </SettingsIconButton>
              <SettingsIconButton
                testId="web-search-model-remove"
                aria-label={tr("features.web.modelsRemove", { name })}
                disabled={props.busy || list.length === 1}
                onClick={() => setList(list.filter((m) => m !== id))}
              >
                <X className="size-3.5" strokeWidth={1.75} />
              </SettingsIconButton>
            </span>
          );
        })}
      </span>
      <span className="web-search-form">
        {rest.length && list.length < MAX_SEARCH_MODELS ? (
          <SettingsSelect
            testId="web-search-model-add"
            aria-label={tr("features.web.modelsAdd")}
            value=""
            disabled={props.busy}
            options={[
              { value: "", label: tr("features.web.modelsAdd") },
              ...rest.map((model) => ({ value: model.id, label: model.name })),
            ]}
            onChange={(id) => id && setList([...list, id])}
          />
        ) : null}
        <SettingsButton
          testId="web-search-models-save"
          disabled={props.busy || list.length === 0}
          onClick={() => props.onSave(list)}
        >
          {tr("features.web.save")}
        </SettingsButton>
        <SettingsButton variant="ghost" disabled={props.busy} onClick={props.onCancel}>
          {tr("features.web.cancel")}
        </SettingsButton>
      </span>
    </span>
  );
}
