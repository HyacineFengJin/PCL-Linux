import { t } from "./i18n";
import { useState } from "react";
import type { Api } from "./types";
import { ToolboxDownload } from "./ToolboxDownload";
import { ToolboxGenerators } from "./ToolboxGenerators";
import type { LocalTool } from "./useLauncherLocal";
import "./toolbox-extra.css";
export function Toolbox({
  onOpen,
  api,
  onTaskStart,
  onTool,
  native = false,
  busy = false,
  networkSubmissionDisabled = false,
  networkSubmissionReason,
}: {
  onOpen: (s: string) => void;
  root?: string;
  api?: Api;
  onTaskStart?: (id: string) => void;
  onTool?: (tool: LocalTool) => Promise<void>;
  native?: boolean;
  busy?: boolean;
  networkSubmissionDisabled?: boolean;
  networkSubmissionReason?: string;
}) {
  const [player, setPlayer] = useState(""),
    [server, setServer] = useState("");
  const unavailable = t("common.unavailable");
  return (
    <div className="ce-toolbox">
      <section className="ce-card">
        <h2 className="ce-card-title">{t("nav.toolbox")}</h2>
        <div className="ce-actions toolbox-actions">
          <button className="ce-button" disabled title={unavailable}>
            {t("toolbox.clean")}
          </button>
          <button
            className="ce-button"
            disabled={busy || !onTool}
            onClick={() => void onTool?.("luck")}
          >
            {t("toolbox.luck")}
          </button>
          <button
            className="ce-button"
            disabled={busy || !onTool || !native}
            onClick={() => void onTool?.("shortcuts")}
          >
            {t("toolbox.shortcut")}
          </button>
          <button
            className="ce-button"
            disabled={busy || !onTool || !native}
            onClick={() => void onTool?.("statistics")}
          >
            {t("toolbox.stats")}
          </button>
        </div>
      </section>
      <ToolboxDownload
        api={api}
        native={native}
        disabled={busy}
        startDisabled={networkSubmissionDisabled}
        startDisabledReason={networkSubmissionReason}
        onTaskStart={onTaskStart}
      />
      <section className="ce-card">
        <h2 className="ce-card-title">{t("toolbox.skinTitle")}</h2>
        <div className="toolbox-skin">
          <label className="ce-row">
            <span>{t("toolbox.player")}</span>
            <input
              className="ce-field"
              value={player}
              onChange={(e) => setPlayer(e.target.value)}
            />
          </label>
          <button className="ce-button" disabled title={unavailable}>
            {t("toolbox.skinSave")}
          </button>
        </div>
      </section>
      <section className="ce-card">
        <h2 className="ce-card-title">{t("toolbox.server")}</h2>
        <div className="ce-inline">
          <input
            className="ce-field"
            placeholder={t("toolbox.serverAddress")}
            value={server}
            onChange={(e) => setServer(e.target.value)}
          />
          <button className="ce-button" disabled title={unavailable}>
            {t("toolbox.query")}
          </button>
        </div>
      </section>
      <ToolboxGenerators api={api} native={native} disabled={busy} />
    </div>
  );
}
