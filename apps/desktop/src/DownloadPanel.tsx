import { useEffect, useRef, useState } from "react";
import {
  Box,
  Pickaxe,
  ChevronDown,
  Download,
  Globe,
  ListFilter,
  ArrowUpToLine,
  LoaderCircle,
  RefreshCw,
  Search,
  TriangleAlert,
  X,
} from "lucide-react";

import { Favorites, LoaderCatalog, installerPages } from "./LoaderCatalog";
import { Collapse } from "./Collapse";
import { InstallSelection } from "./InstallSelection";
import type { ResourceSummary } from "./ResourceDetails";
import grassIcon from "./assets/game-icons/grass.png";
import commandIcon from "./assets/game-icons/command.png";

export type DownloadStatus = {
  stage:
    "idle" | "preparing" | "downloading" | "complete" | "error" | "cancelled";
  phase?: string;
  message: string;
  version: string | null;
  completed: number;
  total: number;
  bytes_done: number;
  bytes_total: number;
  network_bytes?: number;
  result?: {
    id: string;
    java_major: number;
    files_downloaded: number;
    files_reused: number;
  } | null;
};
type VersionEntry = { id: string; kind: string; release_time: string };
export const idleDownload: DownloadStatus = {
  stage: "idle",
  message: "",
  version: null,
  completed: 0,
  total: 0,
  bytes_done: 0,
  bytes_total: 0,
};
const active = (status: DownloadStatus) =>
  ["preparing", "downloading"].includes(status.stage);
const kindName = (kind: string) =>
  kind === "release" ? "正式版" : kind === "snapshot" ? "快照版" : "旧版";

export function DownloadPanel({
  api,
  native,
  installed,
  gameBusy,
  onInstalled,
  onBusyChange,
  onStatusChange,
  onResourceDetails,
  onTaskStart,
  section = "minecraft",
}: {
  api: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
  native: boolean;
  section?: string;
  installed: { id: string }[];
  gameBusy: boolean;
  onInstalled: () => Promise<void>;
  onBusyChange: (busy: boolean) => void;
  onStatusChange: (status: DownloadStatus) => void;
  onResourceDetails: (resource: ResourceSummary) => void;
  onTaskStart: () => void;
}) {
  const [catalog, setCatalog] = useState<VersionEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<string[]>([]);
  const [choice, setChoice] = useState<VersionEntry | null>(null);
  const [status, setStatus] = useState<DownloadStatus>(idleDownload);
  const [working, setWorking] = useState(false);
  const completed = useRef("");
  const starting = useRef(false);
  const callbacks = useRef({
    onInstalled,
    onBusyChange,
    onStatusChange,
    onTaskStart,
  });
  callbacks.current = {
    onInstalled,
    onBusyChange,
    onStatusChange,
    onTaskStart,
  };
  useEffect(() => {
    setChoice(null);
  }, [section]);
  async function loadCatalog(refresh = false) {
    setLoading(true);
    setError("");
    try {
      setCatalog(await api<VersionEntry[]>("download_catalog", { refresh }));
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void loadCatalog();
  }, []);
  useEffect(() => {
    let disposed = false;
    let polling = false;
    async function poll() {
      if (polling || starting.current) return;
      polling = true;
      try {
        const next = await api<DownloadStatus>("download_status");
        if (disposed || starting.current) return;
        setStatus(next);
        callbacks.current.onStatusChange(next);
        callbacks.current.onBusyChange(active(next));
        if (active(next)) completed.current = "";
        if (
          next.stage === "complete" &&
          next.version &&
          completed.current !== next.version
        ) {
          completed.current = next.version;
          await callbacks.current.onInstalled();
        }
      } catch (e) {
        if (!disposed) setError(String(e));
      } finally {
        polling = false;
      }
    }
    void poll();
    const timer = window.setInterval(poll, 1000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, []);
  const busy = active(status) || working;
  const ids = new Set(installed.map((item) => item.id));
  const aprilVersions = new Set([
    "26w14a",
    "25w14craftmine",
    "24w14potato",
    "23w13a_or_b",
    "22w13oneblockatatime",
    "20w14infinite",
    "3D Shareware v1.34",
    "1.RV-Pre1",
    "15w14a",
    "2.0",
  ]);
  const groups = [
    {
      id: "release",
      title: "正式版",
      entries: catalog.filter(
        (e) => e.kind === "release" && !aprilVersions.has(e.id),
      ),
    },
    {
      id: "snapshot",
      title: "预览版",
      entries: catalog.filter(
        (e) => e.kind === "snapshot" && !aprilVersions.has(e.id),
      ),
    },
    {
      id: "old",
      title: "远古版",
      entries: catalog.filter(
        (e) =>
          !["release", "snapshot"].includes(e.kind) && !aprilVersions.has(e.id),
      ),
    },
    {
      id: "april",
      title: "愚人节版",
      entries: catalog.filter((e) => aprilVersions.has(e.id)),
    },
  ];
  const latest = [
    catalog.find((e) => e.kind === "release"),
    catalog.find((e) => e.kind === "snapshot" && !aprilVersions.has(e.id)),
  ].filter((e): e is VersionEntry => Boolean(e));
  const resourceLabels: Record<string, string> = {
    mods: "模组",
    modpacks: "整合包",
    datapacks: "数据包",
    resourcepacks: "资源包",
    shaders: "光影包",
    worlds: "世界",
    favorites: "收藏夹",
  };
  const community = resourceLabels[section];
  function versionRow(entry: VersionEntry, newest = false) {
    return (
      <button
        key={entry.id}
        className={`resource-row ce-version-row ${choice?.id === entry.id ? "chosen" : ""}`}
        disabled={busy || gameBusy || ids.has(entry.id)}
        onClick={() => setChoice(entry)}
      >
        <span
          className={`resource-icon ce-minecraft-icon ${entry.kind === "release" ? "grass" : "command"}`}
        >
          <img
            src={entry.kind === "release" ? grassIcon : commandIcon}
            alt=""
          />
        </span>
        <span className="ce-resource-text">
          <strong>{entry.id}</strong>
          <small>
            {newest
              ? entry.kind === "release"
                ? "最新正式版"
                : "最新预览版"
              : kindName(entry.kind)}
            ，发布于{" "}
            {new Date(entry.release_time).toLocaleString("zh-CN", {
              year: "numeric",
              month: "numeric",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
              hour12: false,
            })}
          </small>
        </span>
        {ids.has(entry.id) && <span className="tag">已安装</span>}
      </button>
    );
  }
  async function start() {
    if (!choice || gameBusy || busy || !native) return;
    starting.current = true;
    setWorking(true);
    setError("");
    callbacks.current.onBusyChange(true);
    try {
      await api("download_start", { id: choice.id });
      completed.current = "";
      const next = await api<DownloadStatus>("download_status");
      setStatus(next);
      callbacks.current.onStatusChange(next);
      callbacks.current.onTaskStart();
      callbacks.current.onBusyChange(active(next));
      setChoice(null);
    } catch (e) {
      setError(String(e));
      callbacks.current.onBusyChange(false);
    } finally {
      starting.current = false;
      setWorking(false);
    }
  }
  return (
    <>
      {gameBusy && (
        <div className="auth-notice">
          游戏正在准备或运行，请结束游戏后再安装新版本。
        </div>
      )}
      {error && (
        <div className="error-banner" role="alert">
          <TriangleAlert size={17} />
          <span>{error}</span>
          <button
            className="icon-button"
            onClick={() => setError("")}
            aria-label="关闭提示"
          >
            <X size={15} />
          </button>
        </div>
      )}
      {choice && section === "minecraft" ? (
        <InstallSelection
          key={choice.id}
          api={api}
          version={choice.id}
          native={native}
          disabled={busy || gameBusy || ids.has(choice.id)}
          onBack={() => setChoice(null)}
          onStart={start}
        />
      ) : (
        <div className="ce-page-enter" key={section}>
          {section === "favorites" ? (
            <Favorites />
          ) : installerPages.includes(section) ? (
            <LoaderCatalog
              key={section}
              api={api}
              loader={section}
              catalog={catalog}
              catalogLoading={loading}
            />
          ) : community ? (
            <CommunityCatalog
              api={api}
              key={section}
              label={community}
              query={query}
              setQuery={setQuery}
              onResourceDetails={onResourceDetails}
            />
          ) : section !== "minecraft" ? (
            <section className="ce-card">
              <div className="ce-card-title">{section}</div>
              <p className="muted">此安装包目录尚未接入。</p>
            </section>
          ) : (
            <>
              <section className="ce-card ce-catalog-latest">
                <div className="ce-card-title">最新版本</div>
                {loading ? (
                  <div className="download-empty">
                    <LoaderCircle className="spin" size={22} />
                    <p>正在获取官方版本目录…</p>
                  </div>
                ) : latest.length ? (
                  latest.map((entry) => versionRow(entry, true))
                ) : (
                  <div className="download-empty">
                    <p>
                      {native
                        ? "暂未获取到版本目录"
                        : "版本目录将在桌面应用中显示"}
                    </p>
                    <button
                      className="ce-button"
                      disabled={!native || loading}
                      onClick={() => void loadCatalog(true)}
                    >
                      <RefreshCw size={14} />
                      重新获取
                    </button>
                  </div>
                )}
              </section>
              {groups.map((group) => (
                <section className="ce-card ce-version-group" key={group.id}>
                  <button
                    className="ce-version-group-toggle"
                    onClick={() =>
                      setExpanded((old) =>
                        old.includes(group.id)
                          ? old.filter((id) => id !== group.id)
                          : [...old, group.id],
                      )
                    }
                    aria-expanded={expanded.includes(group.id)}
                  >
                    <span>
                      {group.title} ({group.entries.length})
                    </span>
                    <ChevronDown
                      size={19}
                      className={`ce-disclosure-arrow ${expanded.includes(group.id) ? "is-open" : ""}`}
                    />
                  </button>
                  <Collapse open={expanded.includes(group.id)}>
                    <div className="ce-version-group-list">
                      {group.entries.length ? (
                        group.entries.map((entry) => versionRow(entry))
                      ) : (
                        <p className="muted">暂无版本</p>
                      )}
                    </div>
                  </Collapse>
                </section>
              ))}
            </>
          )}
        </div>
      )}
    </>
  );
}

type ModrinthHit = {
  project_id: string;
  title: string;
  description: string;
  icon_url: string | null;
  categories: string[];
  display_categories: string[];
  versions: string[];
  downloads: number;
  date_modified: string;
};

function CommunityCatalog({
  api,
  label,
  query,
  setQuery,
  onResourceDetails,
}: {
  api: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
  label: string;
  query: string;
  setQuery: (value: string) => void;
  onResourceDetails: (resource: ResourceSummary) => void;
}) {
  const [source, setSource] = useState("全部");
  const [tag, setTag] = useState("全部");
  const [sort, setSort] = useState("默认");
  const [version, setVersion] = useState("任意");
  const [loader, setLoader] = useState("任意");
  const [request, setRequest] = useState<Record<string, unknown>>({
    query,
    sort: query.trim() ? "relevance" : "downloads",
  });
  const [hits, setHits] = useState<ModrinthHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const apiRef = useRef(api);
  apiRef.current = api;
  useEffect(() => {
    if (label === "世界") return;
    let disposed = false;
    setLoading(true);
    setError("");
    apiRef
      .current<{ hits: ModrinthHit[] }>("modrinth_search", {
        ...request,
        projectType: {
          模组: "mod",
          整合包: "modpack",
          数据包: "datapack",
          资源包: "resourcepack",
          光影包: "shader",
        }[label],
      })
      .then((result) => {
        if (!disposed) setHits(result.hits);
      })
      .catch((reason) => {
        if (!disposed) {
          setError(String(reason));
          setHits([]);
        }
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [label, request]);
  function search() {
    setRequest({
      query,
      source,
      sort:
        sort === "更新时间"
          ? "updated"
          : sort === "默认" && query.trim()
            ? "relevance"
            : "downloads",
      version: version === "任意" ? undefined : version,
      loader: loader === "任意" ? undefined : loader.toLowerCase(),
      tag: tag === "全部" ? undefined : tag,
    });
  }
  const availableVersions = [...new Set(hits.flatMap((hit) => hit.versions))]
    .filter((value) => /^\d+\.\d+(\.\d+)?$/.test(value))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  const loaderNames: Record<string, string> = {
    fabric: "Fabric",
    forge: "Forge",
    neoforge: "NeoForge",
    quilt: "Quilt",
  };
  const categoryNames: Record<string, string> = {
    library: "支持库",
    optimization: "性能优化",
    utility: "实用",
    decoration: "装饰",
    adventure: "冒险",
    technology: "科技",
    worldgen: "世界生成",
    storage: "存储",
    equipment: "装备",
    magic: "魔法",
    management: "管理",
  };
  const tags = [
    ...new Set(
      hits
        .flatMap((hit) => hit.display_categories)
        .filter((value) => !loaderNames[value]),
    ),
  ];
  function downloads(value: number) {
    return value >= 100000000
      ? `${(value / 100000000).toFixed(2).replace(/0+$/, "").replace(/\.$/, "")} 亿`
      : value >= 10000
        ? `${(value / 10000).toFixed(1).replace(/\.0$/, "")} 万`
        : value.toLocaleString("zh-CN");
  }
  function updated(value: string) {
    const days = Math.max(
      0,
      Math.floor((Date.now() - new Date(value).getTime()) / 86400000),
    );
    return days < 1
      ? "今天"
      : days < 7
        ? `${days} 天前`
        : days < 30
          ? `${Math.floor(days / 7)} 周前`
          : days < 365
            ? `${Math.floor(days / 30)} 个月前`
            : `${Math.floor(days / 365)} 年前`;
  }
  function safeIcon(value: string | null) {
    try {
      const url = new URL(value || "");
      return url.protocol === "https:" && url.hostname === "cdn.modrinth.com"
        ? url.href
        : undefined;
    } catch {
      return undefined;
    }
  }

  return (
    <>
      <form
        className="ce-card ce-community-search"
        onSubmit={(event) => {
          event.preventDefault();
          search();
        }}
      >
        <Search size={19} />
        <input
          className="ce-search"
          placeholder={`搜索${label}`}
          aria-label={`搜索${label}`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button className="ce-button" type="submit">
          搜索
        </button>
      </form>
      <section className="ce-card ce-community-filters">
        <label className="ce-filter-field">
          来源
          <select
            className="ce-field"
            value={source}
            onChange={(e) => setSource(e.target.value)}
          >
            {["全部", "Modrinth", "CurseForge"].map((v) => (
              <option key={v} disabled={v === "CurseForge"}>
                {v === "CurseForge" ? "CurseForge（尚未接入）" : v}
              </option>
            ))}
          </select>
        </label>
        <label className="ce-filter-field">
          标签
          <select
            className="ce-field"
            value={tag}
            onChange={(e) => setTag(e.target.value)}
          >
            <option>全部</option>
            {tags.map((value) => (
              <option key={value} value={value}>
                {categoryNames[value] || value}
              </option>
            ))}
          </select>
        </label>
        <label className="ce-filter-field">
          排序方式
          <select
            className="ce-field"
            value={sort}
            onChange={(e) => setSort(e.target.value)}
          >
            {["默认", "下载量", "更新时间"].map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
        </label>
        <button
          className="icon-button ce-filter-reset"
          aria-label="重置筛选"
          onClick={() => {
            setQuery("");
            setSource("全部");
            setTag("全部");
            setSort("默认");
            setVersion("任意");
            setLoader("任意");
            setRequest({ query: "", sort: "downloads" });
          }}
        >
          <RefreshCw size={22} />
        </button>
        <label className="ce-filter-field">
          版本
          <select
            className="ce-field"
            value={version}
            onChange={(e) => setVersion(e.target.value)}
          >
            <option>任意</option>
            {availableVersions.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        <label className="ce-filter-field">
          加载器
          <select
            className="ce-field"
            value={loader}
            onChange={(e) => setLoader(e.target.value)}
          >
            {["任意", "Fabric", "Forge", "NeoForge", "Quilt"].map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
        </label>
      </section>
      <section
        className={
          loading ? "ce-community-loading" : "ce-card ce-community-results"
        }
        aria-busy={loading}
      >
        {loading ? (
          <div className="ce-card ce-community-loading-box" role="status">
            <Pickaxe size={38} strokeWidth={1.5} />
            <i />
            <p>正在获取 {label} 列表</p>
          </div>
        ) : error ? (
          <div className="download-empty" role="alert">
            <TriangleAlert size={24} />
            <p>{error}</p>
            <button className="ce-button" onClick={search}>
              重试
            </button>
          </div>
        ) : !hits.length ? (
          <div className="download-empty">
            <Search size={30} strokeWidth={1.3} />
            <p>
              {label === "世界"
                ? "世界目录尚未接入。"
                : `没有符合条件的${label}`}
            </p>
          </div>
        ) : (
          hits.map((hit) => {
            const loaders = hit.categories
              .filter((value) => loaderNames[value])
              .map((value) => loaderNames[value]);
            const releases = hit.versions
              .filter((value) => /^\d+\.\d+(\.\d+)?$/.test(value))
              .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
            const versions =
              releases.length > 1
                ? `${releases[0]} – ${releases[releases.length - 1]}`
                : releases[0] || hit.versions[0] || "";
            const icon = safeIcon(hit.icon_url);
            return (
              <article
                className="ce-mod-row"
                key={hit.project_id}
                role="button"
                tabIndex={0}
                aria-label={`查看 ${hit.title} 详情`}
                onClick={() =>
                  onResourceDetails({
                    ...hit,
                    source: "Modrinth",
                    project_type: (
                      {
                        模组: "mod",
                        整合包: "modpack",
                        数据包: "datapack",
                        资源包: "resourcepack",
                        光影包: "shader",
                      } as Record<string, string>
                    )[label],
                  })
                }
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onResourceDetails({
                      ...hit,
                      source: "Modrinth",
                      project_type: (
                        {
                          模组: "mod",
                          整合包: "modpack",
                          数据包: "datapack",
                          资源包: "resourcepack",
                          光影包: "shader",
                        } as Record<string, string>
                      )[label],
                    });
                  }
                }}
              >
                {icon ? (
                  <img
                    className="ce-mod-icon"
                    src={icon}
                    alt=""
                    loading="lazy"
                  />
                ) : (
                  <span className="ce-mod-icon">
                    <Box size={32} />
                  </span>
                )}
                <div className="ce-mod-body">
                  <div className="ce-mod-title">{hit.title}</div>
                  <div className="ce-mod-description">
                    {hit.display_categories
                      .filter((value) => !loaderNames[value])
                      .slice(0, 2)
                      .map((value) => (
                        <span className="ce-mod-tag" key={value}>
                          {categoryNames[value] || value}
                        </span>
                      ))}
                    <span>{hit.description}</span>
                  </div>
                  <div className="ce-mod-meta">
                    <span>
                      <ListFilter size={13} />
                      <span className="ce-mod-version">
                        {[loaders.join(" / "), versions]
                          .filter(Boolean)
                          .join(", ")}
                      </span>
                    </span>
                    <span>
                      <Download size={13} />
                      {downloads(hit.downloads)}
                    </span>
                    <span
                      title={new Date(hit.date_modified).toLocaleString(
                        "zh-CN",
                      )}
                    >
                      <ArrowUpToLine size={13} />
                      {updated(hit.date_modified)}
                    </span>
                    <span>
                      <Globe size={13} />
                      Modrinth
                    </span>
                  </div>
                </div>
              </article>
            );
          })
        )}
      </section>
    </>
  );
}
