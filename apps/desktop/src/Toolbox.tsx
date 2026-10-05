import { t } from "./i18n";
import { useState } from "react";
import { ChevronDown } from "lucide-react";
import type { LocalTool } from "./useLauncherLocal";
import { Collapse } from "./Collapse";
import "./toolbox-extra.css";
export function Toolbox({
  onOpen,
  root,
  onTool,
  native = false,
  busy = false,
}: {
  onOpen: (s: string) => void;
  root: string;
  onTool?: (tool: LocalTool) => Promise<void>;
  native?: boolean;
  busy?: boolean;
}) {
  const [url, setUrl] = useState(""),
    [name, setName] = useState(""),
    [player, setPlayer] = useState(""),
    [server, setServer] = useState("");
  const [achievementOpen, setAchievementOpen] = useState(true),
    [avatarOpen, setAvatarOpen] = useState(true),
    [itemId, setItemId] = useState(""),
    [achievementName, setAchievementName] = useState(""),
    [achievementLine1, setAchievementLine1] = useState(""),
    [achievementLine2, setAchievementLine2] = useState(""),
    [avatarSize, setAvatarSize] = useState("64");
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
      <section className="ce-card">
        <h2 className="ce-card-title">{t("toolbox.download")}</h2>
        <div className="toolbox-content">
          <p>{t("toolbox.downloadHelp")}</p>
          <label className="ce-row">
            <span>{t("toolbox.url")}</span>
            <input
              className="ce-field"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          </label>
          <label className="ce-row">
            <span>{t("toolbox.destination")}</span>
            <div className="ce-inline">
              <input className="ce-field" value={root} readOnly />
              <button className="ce-text-button" disabled title={unavailable}>
                {t("toolbox.choose")}
              </button>
            </div>
          </label>
          <label className="ce-row">
            <span>{t("toolbox.fileName")}</span>
            <input
              className="ce-field"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <div className="toolbox-download-actions">
            <button className="ce-button" disabled title={unavailable}>
              {t("toolbox.start")}
            </button>
            <button className="ce-button" onClick={() => onOpen("game")}>
              {t("common.openFolder")}
            </button>
          </div>
        </div>
      </section>
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
      <section className="ce-card toolbox-generator">
        <h2 className="ce-card-title toolbox-generator-title">
          <button
            className="ce-collapse"
            aria-expanded={achievementOpen}
            aria-controls="toolbox-achievement-fields"
            onClick={() => setAchievementOpen((open) => !open)}
          >
            <strong>{t("toolbox.achievement")}</strong>
            <ChevronDown
              size={16}
              className={`ce-disclosure-arrow ${achievementOpen ? "is-open" : ""}`}
              aria-hidden="true"
            />
          </button>
        </h2>
        <Collapse open={achievementOpen}>
          <div
            id="toolbox-achievement-fields"
            className="toolbox-generator-content toolbox-achievement-fields"
          >
            <label className="ce-row">
              <span>{t("toolbox.item")}</span>
              <input
                className="ce-field"
                value={itemId}
                onChange={(e) => setItemId(e.target.value)}
              />
            </label>
            <label className="ce-row">
              <span>{t("toolbox.achievementName")}</span>
              <input
                className="ce-field"
                value={achievementName}
                onChange={(e) => setAchievementName(e.target.value)}
              />
            </label>
            <label className="ce-row">
              <span>{t("toolbox.line1")}</span>
              <input
                className="ce-field"
                value={achievementLine1}
                onChange={(e) => setAchievementLine1(e.target.value)}
              />
            </label>
            <label className="ce-row">
              <span>{t("toolbox.line2")}</span>
              <input
                className="ce-field"
                value={achievementLine2}
                onChange={(e) => setAchievementLine2(e.target.value)}
              />
            </label>
            <div className="toolbox-generator-actions">
              <button
                className="ce-button"
                disabled
                title={t("toolbox.achievementUnavailable")}
                aria-describedby="toolbox-achievement-status"
              >
                {t("toolbox.previewAchievement")}
              </button>
              <button
                className="ce-button"
                disabled
                title={t("toolbox.achievementSaveUnavailable")}
                aria-describedby="toolbox-achievement-status"
              >
                {t("toolbox.saveImage")}
              </button>
            </div>
            <p
              id="toolbox-achievement-status"
              className="toolbox-generator-status"
              role="status"
            >
              {t("toolbox.achievementBothUnavailable")}
            </p>
          </div>
        </Collapse>
      </section>
      <section className="ce-card toolbox-generator">
        <h2 className="ce-card-title toolbox-generator-title">
          <button
            className="ce-collapse"
            aria-expanded={avatarOpen}
            aria-controls="toolbox-avatar-fields"
            onClick={() => setAvatarOpen((open) => !open)}
          >
            <strong>{t("toolbox.avatar")}</strong>
            <ChevronDown
              size={16}
              className={`ce-disclosure-arrow ${avatarOpen ? "is-open" : ""}`}
              aria-hidden="true"
            />
          </button>
        </h2>
        <Collapse open={avatarOpen}>
          <div
            id="toolbox-avatar-fields"
            className="toolbox-generator-content toolbox-avatar-fields"
          >
            <label className="ce-row">
              <span>{t("toolbox.avatarSize")}</span>
              <select
                className="ce-field"
                value={avatarSize}
                onChange={(e) => setAvatarSize(e.target.value)}
              >
                {[8, 16, 32, 64, 128, 256, 512].map((size) => (
                  <option key={size} value={size}>
                    {size}x{size}
                  </option>
                ))}
              </select>
            </label>
            <div className="toolbox-generator-actions toolbox-avatar-actions">
              <button
                className="ce-button"
                disabled
                title={t("toolbox.skinChooseUnavailable")}
                aria-describedby="toolbox-avatar-status"
              >
                {t("toolbox.skinChoose")}
              </button>
              <button
                className="ce-button"
                disabled
                title={t("toolbox.avatarSaveUnavailable")}
                aria-describedby="toolbox-avatar-status"
              >
                {t("toolbox.avatarSave")}
              </button>
            </div>
            <p
              id="toolbox-avatar-status"
              className="toolbox-generator-status"
              role="status"
            >
              {t("toolbox.avatarUnavailable")}
            </p>
          </div>
        </Collapse>
      </section>
    </div>
  );
}
