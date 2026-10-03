import { useEffect, useState } from "react";
import { ChevronDown, ChevronUp, Settings } from "lucide-react";
import type { Api } from "./types";
import neoForge from "./assets/game-icons/neoforge.png";
export function Favorites() {
  return (
    <div className="ce-state-stage ce-favorites-empty">
      <div className="ce-card ce-favorites-toolbar">
        <select className="ce-field" disabled title="收藏夹管理尚未开放">
          <option>默认</option>
        </select>
        <button
          className="icon-button"
          disabled
          title="收藏夹管理尚未开放"
          aria-label="收藏夹设置"
        >
          <Settings size={16} />
        </button>
      </div>
      <section className="ce-card ce-state-box">
        <h2>还没有收藏内容</h2>
        <p>在资源详细信息界面中可以点击收藏按钮进行收藏</p>
      </section>
    </div>
  );
}
type Group = { minecraft: string; versions: string[] };
export function LoaderCatalog({ api, loader }: { api: Api; loader: string }) {
  const [groups, setGroups] = useState<Group[]>([]),
    [expanded, setExpanded] = useState<string[]>([]),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  useEffect(() => {
    let live = true;
    setLoading(true);
    setGroups([]);
    setError("");
    api<Group[]>("loader_catalog", { loader })
      .then((v) => {
        if (live) setGroups(v);
      })
      .catch((e) => {
        if (live) setError(String(e));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [api, loader]);
  return (
    <>
      <section className="ce-card ce-loader-intro">
        <h2 className="ce-card-title">{loader} 简介</h2>
        <p>
          NeoForge 是 Minecraft 1.20.1+ 的模组加载器，你需要先安装它才能安装各种
          NeoForge 模组，它也兼容一些 Forge 模组。
          <br />
          本页面提供 NeoForge 安装器下载，在下载后你需要手动打开安装器进行安装。
        </p>
        <button
          className="ce-button primary"
          onClick={() => api("ui_open_link", { url: "https://neoforged.net/" })}
        >
          打开官网
        </button>
      </section>
      {loading ? (
        <section className="ce-card">
          <p className="ce-empty">正在获取安装包目录…</p>
        </section>
      ) : error ? (
        <section className="ce-card">
          <p className="ce-empty">{error}</p>
        </section>
      ) : !groups.length ? (
        <section className="ce-card">
          <p className="ce-empty">暂无安装包目录</p>
        </section>
      ) : (
        groups.map((group) => (
          <section className="ce-card ce-loader-group" key={group.minecraft}>
            <button
              className="ce-version-group-toggle"
              aria-expanded={expanded.includes(group.minecraft)}
              onClick={() =>
                setExpanded((v) =>
                  v.includes(group.minecraft)
                    ? v.filter((x) => x !== group.minecraft)
                    : [...v, group.minecraft],
                )
              }
            >
              {group.minecraft} ({group.versions.length})
              {expanded.includes(group.minecraft) ? (
                <ChevronUp size={17} />
              ) : (
                <ChevronDown size={17} />
              )}
            </button>
            {expanded.includes(group.minecraft) &&
              group.versions.map((v) => (
                <button
                  className="ce-loader-entry"
                  disabled
                  title="安装器下载尚未开放"
                  key={v}
                >
                  <img className="instance-icon" src={neoForge} alt="" />
                  <div>
                    NeoForge {v}
                    <small>Minecraft {group.minecraft}</small>
                  </div>
                </button>
              ))}
          </section>
        ))
      )}
    </>
  );
}
