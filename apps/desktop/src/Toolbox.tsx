import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { Collapse } from "./Collapse";
import "./toolbox-extra.css";
export function Toolbox({
  onOpen,
  root,
}: {
  onOpen: (s: string) => void;
  root: string;
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
  const unavailable = "此功能尚未开放";
  return (
    <div className="ce-toolbox">
      <section className="ce-card">
        <h2 className="ce-card-title">百宝箱</h2>
        <div className="ce-actions toolbox-actions">
          <button className="ce-button" disabled title={unavailable}>
            清理游戏垃圾
          </button>
          <button className="ce-button" disabled title={unavailable}>
            今日人品
          </button>
          <button className="ce-button" disabled title={unavailable}>
            创建快捷方式
          </button>
          <button className="ce-button" disabled title={unavailable}>
            查看启动次数
          </button>
        </div>
      </section>
      <section className="ce-card">
        <h2 className="ce-card-title">下载自定义文件</h2>
        <div className="toolbox-content">
          <p>下载指定链接的文件。部分网站可能限制下载，返回 403 等错误。</p>
          <label className="ce-row">
            <span>下载地址</span>
            <input
              className="ce-field"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          </label>
          <label className="ce-row">
            <span>保存到</span>
            <div className="ce-inline">
              <input className="ce-field" value={root} readOnly />
              <button className="ce-text-button" disabled title={unavailable}>
                选择
              </button>
            </div>
          </label>
          <label className="ce-row">
            <span>文件名</span>
            <input
              className="ce-field"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <div className="toolbox-download-actions">
            <button className="ce-button" disabled title={unavailable}>
              开始下载
            </button>
            <button className="ce-button" onClick={() => onOpen("game")}>
              打开文件夹
            </button>
          </div>
        </div>
      </section>
      <section className="ce-card">
        <h2 className="ce-card-title">下载正版玩家的皮肤</h2>
        <div className="toolbox-skin">
          <label className="ce-row">
            <span>正版玩家名</span>
            <input
              className="ce-field"
              value={player}
              onChange={(e) => setPlayer(e.target.value)}
            />
          </label>
          <button className="ce-button" disabled title={unavailable}>
            保存皮肤
          </button>
        </div>
      </section>
      <section className="ce-card">
        <h2 className="ce-card-title">瞅眼服务器</h2>
        <div className="ce-inline">
          <input
            className="ce-field"
            placeholder="输入服务器地址"
            value={server}
            onChange={(e) => setServer(e.target.value)}
          />
          <button className="ce-button" disabled title={unavailable}>
            查询
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
            <strong>自定义成就图片生成器 (仅支持英文)</strong>
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
              <span>物品名（ID）</span>
              <input
                className="ce-field"
                value={itemId}
                onChange={(e) => setItemId(e.target.value)}
              />
            </label>
            <label className="ce-row">
              <span>成就名</span>
              <input
                className="ce-field"
                value={achievementName}
                onChange={(e) => setAchievementName(e.target.value)}
              />
            </label>
            <label className="ce-row">
              <span>第一行</span>
              <input
                className="ce-field"
                value={achievementLine1}
                onChange={(e) => setAchievementLine1(e.target.value)}
              />
            </label>
            <label className="ce-row">
              <span>第二行（可选）</span>
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
                title="成就图片生成尚未开放"
                aria-describedby="toolbox-achievement-status"
              >
                预览成就图像
              </button>
              <button
                className="ce-button"
                disabled
                title="成就图片保存尚未开放"
                aria-describedby="toolbox-achievement-status"
              >
                保存图片
              </button>
            </div>
            <p
              id="toolbox-achievement-status"
              className="toolbox-generator-status"
              role="status"
            >
              成就图片生成与保存尚未开放
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
            <strong>皮肤头像生成器</strong>
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
              <span>头像大小：</span>
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
                title="皮肤文件选择尚未开放"
                aria-describedby="toolbox-avatar-status"
              >
                选择皮肤
              </button>
              <button
                className="ce-button"
                disabled
                title="皮肤头像保存尚未开放"
                aria-describedby="toolbox-avatar-status"
              >
                保存头像
              </button>
            </div>
            <p
              id="toolbox-avatar-status"
              className="toolbox-generator-status"
              role="status"
            >
              皮肤文件选择、头像生成与保存尚未开放
            </p>
          </div>
        </Collapse>
      </section>
    </div>
  );
}
