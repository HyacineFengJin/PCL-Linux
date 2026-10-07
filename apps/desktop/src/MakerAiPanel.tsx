import { ArrowUp, Settings2, Sparkles, X } from "lucide-react";
import { t } from "./i18n";
import type { EngineStatus } from "./experimentalTypes";
import type { MakerUnit } from "./makerWorkspaceState";
export function MakerAiPanel({
  name,
  unit,
  file,
  version,
  blockedReason,
  prompt,
  status,
  disabled,
  latestJob,
  onPrompt,
  onSend,
  onClose,
  onConfigure,
}: {
  name: string;
  unit?: MakerUnit;
  file?: string;
  version?: string;
  blockedReason?: string;
  prompt: string;
  status: EngineStatus | null;
  disabled: boolean;
  latestJob?: string;
  onPrompt: (text: string) => void;
  onSend: () => void;
  onClose: () => void;
  onConfigure?: () => void;
}) {
  const preset = status?.aiPresets.presets.find(
    (value) => value.id === status.aiPresets.selectedId,
  );
  return (
    <aside className="maker-ai-panel" aria-label={t("maker.aiAssistant")}>
      <header>
        <span>
          <Sparkles size={16} />
          {t("maker.aiAssistant")}
        </span>
        <button
          className="maker-icon-button"
          onClick={onClose}
          aria-label={t("maker.closeAi")}
        >
          <X size={16} />
        </button>
      </header>
      <div className="maker-ai-context">
        <small>{t("maker.currentContext")}</small>
        <strong>{name}</strong>
        {version && <small>{version}</small>}
        {unit && <span>{unit.name || t("maker.newFeature")}</span>}
        {file && <code>{file}</code>}
      </div>
      <div className="maker-ai-intro">
        <Sparkles size={22} />
        <h3>{t("maker.aiIntroTitle")}</h3>
        <p>{t("maker.aiIntro")}</p>
        {latestJob && (
          <p className="maker-ai-task-note">{t("maker.aiTaskTracked")}</p>
        )}
      </div>
      <div className="maker-ai-composer">
        <textarea
          className="ce-field"
          rows={7}
          aria-label={t("maker.aiRequest")}
          placeholder={t("maker.aiPlaceholder")}
          maxLength={5000}
          value={prompt}
          onChange={(event) => onPrompt(event.target.value)}
        />
        <div className="maker-composer-footer">
          <span title={preset?.selection.model}>
            {preset?.name || t("maker.noPreset")}
          </span>
          <button
            className="ce-button primary"
            aria-label={t("maker.sendAi")}
            disabled={disabled || !prompt.trim()}
            onClick={onSend}
          >
            <ArrowUp size={16} />
          </button>
        </div>
      </div>
      {!preset && (
        <p className="experimental-origin">{t("maker.choosePreset")}</p>
      )}
      {blockedReason && <p className="experimental-origin">{blockedReason}</p>}
      {onConfigure && (
        <button className="ce-button maker-ai-settings" onClick={onConfigure}>
          <Settings2 size={14} />
          {t("experimental.configureAi")}
        </button>
      )}
      <p className="maker-ai-review-note">{t("maker.aiReviewNote")}</p>
    </aside>
  );
}
