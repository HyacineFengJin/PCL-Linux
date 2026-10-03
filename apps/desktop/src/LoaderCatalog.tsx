import { useEffect, useState } from "react";
import {
  Box,
  ChevronDown,
  FlaskConical,
  Gauge,
  ScrollText,
  Settings,
} from "lucide-react";
import type { Api } from "./types";
import { Collapse } from "./Collapse";
import forge from "./assets/game-icons/forge.png";
import grass from "./assets/game-icons/grass.png";
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
type VersionEntry = { id: string; kind: string; release_time: string };
export const installerPages = [
  "installer-minecraft",
  "OptiFine",
  "Forge",
  "NeoForge",
  "Cleanroom",
  "Fabric",
  "Legacy Fabric",
  "LabyMod",
  "LiteLoader",
];
const providers: Record<
  string,
  { name: string; intro: string; website: string }
> = {
  "installer-minecraft": {
    name: "Minecraft",
    intro:
      "Minecraft 是一款沙盒游戏，你可以在方块组成的世界中探索、建造和冒险。",
    website: "https://www.minecraft.net/",
  },
  NeoForge: {
    name: "NeoForge",
    intro:
      "NeoForge 是 Minecraft 1.20.1+ 的模组加载器，你需要先安装它才能安装各种 NeoForge 模组，它也兼容一些 Forge 模组。",
    website: "https://neoforged.net/",
  },
  Forge: {
    name: "Forge",
    intro:
      "Forge 是 Minecraft 的模组加载器，你需要先安装它才能安装各种 Forge 模组。",
    website: "https://files.minecraftforge.net/",
  },
  OptiFine: {
    name: "OptiFine",
    intro:
      "OptiFine 是 Minecraft 的画面与性能优化模组，提供光影支持和更多视频设置。",
    website: "https://optifine.net/downloads",
  },
  Cleanroom: {
    name: "Cleanroom",
    intro:
      "Cleanroom 是基于 Forge 的 Minecraft 1.12.2 模组加载器，让旧版模组能够使用现代 Java 运行。",
    website: "https://cleanroommc.com/",
  },
  Fabric: {
    name: "Fabric",
    intro:
      "Fabric 是轻量的 Minecraft 模组加载器，你需要先安装它才能安装各种 Fabric 模组。",
    website: "https://fabricmc.net/",
  },
  "Legacy Fabric": {
    name: "Legacy Fabric",
    intro:
      "Legacy Fabric 将 Fabric 模组加载器带到较旧的 Minecraft 版本，你需要先安装它才能使用对应的模组。",
    website: "https://legacyfabric.net/",
  },
  LabyMod: {
    name: "LabyMod",
    intro:
      "LabyMod 为 Minecraft 提供界面增强和多种游戏辅助功能，安装器可在官网获取。",
    website: "https://laby.net/client",
  },
  LiteLoader: {
    name: "LiteLoader",
    intro:
      "LiteLoader 是面向旧版 Minecraft 的轻量模组加载器，可用于加载对应的客户端模组。",
    website: "https://www.liteloader.com/",
  },
};
const cache = new Map<string, { groups: Group[]; time: number }>();
function LoaderIcon({ loader }: { loader: string }) {
  const image =
    loader === "NeoForge"
      ? neoForge
      : loader === "Forge"
        ? forge
        : loader === "installer-minecraft"
          ? grass
          : undefined;
  const Icon =
    loader === "OptiFine"
      ? Gauge
      : loader.includes("Fabric")
        ? ScrollText
        : loader === "Cleanroom"
          ? FlaskConical
          : Box;
  return image ? (
    <img className="instance-icon" src={image} alt="" />
  ) : (
    <span className="instance-icon ce-loader-icon">
      <Icon size={28} strokeWidth={1.5} />
    </span>
  );
}
export function LoaderCatalog({
  api,
  loader,
  catalog,
  catalogLoading,
}: {
  api: Api;
  loader: string;
  catalog: VersionEntry[];
  catalogLoading: boolean;
}) {
  const [groups, setGroups] = useState<Group[]>([]),
    [expanded, setExpanded] = useState<string[]>([]),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [retry, setRetry] = useState(0);
  const provider = providers[loader];
  const minecraft = loader === "installer-minecraft";
  const websiteOnly = loader === "LabyMod";
  useEffect(() => {
    if (minecraft || websiteOnly) {
      setLoading(false);
      return;
    }
    let live = true;
    const cached = cache.get(loader);
    if (!retry && cached && Date.now() - cached.time < 300_000) {
      setGroups(cached.groups);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    api<Group[]>("loader_catalog", { loader })
      .then((groups) => {
        cache.set(loader, { groups, time: Date.now() });
        if (live) setGroups(groups);
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
  }, [api, loader, minecraft, websiteOnly, retry]);
  const shownGroups = minecraft
    ? [
        {
          minecraft: "正式版",
          versions: catalog
            .filter((v) => v.kind === "release")
            .map((v) => v.id),
        },
        {
          minecraft: "预览版",
          versions: catalog
            .filter((v) => v.kind === "snapshot")
            .map((v) => v.id),
        },
        {
          minecraft: "远古版",
          versions: catalog
            .filter((v) => !["release", "snapshot"].includes(v.kind))
            .map((v) => v.id),
        },
      ].filter((g) => g.versions.length)
    : groups;
  return (
    <>
      <section className="ce-card ce-loader-intro">
        <h2 className="ce-card-title">{provider.name} 简介</h2>
        <p>
          {provider.intro}
          <br />
          {minecraft
            ? "本页面列出 Minecraft 的原版游戏文件版本。"
            : websiteOnly
              ? "请前往官网下载适用于 Linux 的安装器。"
              : `本页面提供 ${provider.name} 安装器下载，在下载后你需要手动打开安装器进行安装。`}
        </p>
        <button
          className="ce-button primary"
          onClick={() => {
            setError("");
            api("ui_open_link", { url: provider.website }).catch((e) =>
              setError(String(e)),
            );
          }}
        >
          打开官网
        </button>
      </section>
      {(minecraft ? catalogLoading : loading) ? (
        <section className="ce-card">
          <p className="ce-empty" role="status">
            正在获取安装包目录…
          </p>
        </section>
      ) : error ? (
        <section className="ce-card ce-loader-error">
          <p className="ce-empty" role="alert">
            {error}
          </p>
          <button className="ce-button" onClick={() => setRetry((v) => v + 1)}>
            重新获取
          </button>
        </section>
      ) : websiteOnly ? (
        <section className="ce-card">
          <h2 className="ce-card-title">安装器</h2>
          <p className="ce-empty">LabyMod 安装器由官网提供。</p>
          <button
            className="ce-button primary"
            onClick={() =>
              api("ui_open_link", { url: provider.website }).catch((e) =>
                setError(String(e)),
              )
            }
          >
            前往官网下载
          </button>
        </section>
      ) : !shownGroups.length ? (
        <section className="ce-card">
          <p className="ce-empty">暂无安装包目录</p>
        </section>
      ) : (
        shownGroups.map((group) => (
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
              <ChevronDown
                size={17}
                className={`ce-disclosure-arrow ${expanded.includes(group.minecraft) ? "is-open" : ""}`}
              />
            </button>
            <Collapse open={expanded.includes(group.minecraft)}>
              {group.versions.map((v) => (
                <button
                  className="ce-loader-entry"
                  disabled
                  title={
                    minecraft ? "单文件下载尚未开放" : "安装器下载尚未开放"
                  }
                  key={v}
                >
                  <LoaderIcon loader={loader} />
                  <div>
                    {provider.name}{" "}
                    {loader === "OptiFine" ? v.replaceAll("_", " ") : v}
                    <small>
                      {minecraft
                        ? group.minecraft
                        : group.minecraft === "安装器"
                          ? "安装器"
                          : `Minecraft ${group.minecraft}`}
                    </small>
                  </div>
                </button>
              ))}
            </Collapse>
          </section>
        ))
      )}
    </>
  );
}
