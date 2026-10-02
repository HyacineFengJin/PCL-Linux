import { useState } from "react";
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
          <p>
            使用 PCL CE
            的高速多线程下载引擎下载任意文件。请注意，部分网站（例如百度网盘）可能会报错
            (403) 已禁止，无法正常下载。
          </p>
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
    </div>
  );
}
