import {
  t,
  formatNumber,
  formatDate,
  formatRelativeDate,
  type MessageKey,
} from "./i18n";
import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
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
import { InstallSelection, installNameError } from "./InstallSelection";
import type { InstallOptions } from "./InstallSelection";
import type { ResourceSummary } from "./ResourceDetails";
import grassIcon from "./assets/game-icons/grass.png";
import commandIcon from "./assets/game-icons/command.png";

export type DownloadStep = {
  id: string;
  label: string;
  state: "pending" | "running" | "complete";
  progress?: number | null;
};
export type DownloadStatus = {
  kind?:
    | "install"
    | "instance_reset"
    | "instance_export"
    | "instance_rename"
    | "instance_import"
    | "instance_delete"
    | "instance_restore"
    | "resource_download"
    | "resource_update"
    | "resource_update_restore"
    | "resource_save"
    | "launcher_logs"
    | null;
  stage:
    | "idle"
    | "preparing"
    | "downloading"
    | "processing"
    | "complete"
    | "error"
    | "cancelled";
  phase?: string;
  message: string;
  version: string | null;
  completed: number;
  total: number;
  bytes_done: number;
  bytes_total: number;
  network_bytes?: number;
  task_id?: string | null;
  root_id?: string | null;
  root_path?: string | null;
  progress?: number;
  error?: string | null;
  can_cancel?: boolean;
  steps?: DownloadStep[];
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
  ["preparing", "downloading", "processing"].includes(status.stage);
const kindName = (kind: string) =>
  kind === "release"
    ? t("download.release")
    : kind === "snapshot"
      ? t("download.snapshot")
      : t("download.legacy");

export function DownloadPanel({
  api,
  native,
  rootId,
  rootAvailable = true,
  installed,
  gameBusy,
  onInstalled,
  onBusyChange,
  onStatusChange,
  onResourceDetails,
  onTaskStart,
  visible = true,
  section = "minecraft",
}: {
  api: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
  native: boolean;
  rootId: string | null;
  rootAvailable?: boolean;
  section?: string;
  installed: { id: string }[];
  gameBusy: boolean;
  onInstalled: () => Promise<void>;
  onBusyChange: (busy: boolean) => void;
  onStatusChange: (status: DownloadStatus) => void;
  onResourceDetails: (resource: ResourceSummary) => void;
  onTaskStart: () => void;
  visible?: boolean;
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
  const mounted = useRef(true);
  const statusEpoch = useRef(0);
  const catalogEpoch = useRef(0);
  const latestStatus = useRef<DownloadStatus>(idleDownload);
  const context = useRef({ rootId, section, visible, api, choice });
  if (
    context.current.rootId !== rootId ||
    context.current.section !== section ||
    context.current.visible !== visible ||
    context.current.api !== api ||
    context.current.choice !== choice
  )
    context.current = { rootId, section, visible, api, choice };
  const renderedContext = context.current;
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
    mounted.current = true;
    return () => {
      mounted.current = false;
      statusEpoch.current += 1;
      catalogEpoch.current += 1;
    };
  }, []);
  useEffect(() => {
    setChoice(null);
    setError("");
  }, [section, rootId]);
  async function loadCatalog(refresh = false) {
    const request = ++catalogEpoch.current;
    setLoading(true);
    setError("");
    try {
      const entries = await api<VersionEntry[]>("download_catalog", {
        refresh,
      });
      if (mounted.current && request === catalogEpoch.current)
        setCatalog(entries);
    } catch (e) {
      if (mounted.current && request === catalogEpoch.current)
        setError(String(e));
    } finally {
      if (mounted.current && request === catalogEpoch.current)
        setLoading(false);
    }
  }
  useEffect(() => {
    void loadCatalog();
    return () => {
      catalogEpoch.current += 1;
    };
  }, [api]);
  useEffect(() => {
    let disposed = false;
    let polling = false;
    async function poll() {
      if (polling || starting.current) return;
      const epoch = statusEpoch.current;
      polling = true;
      try {
        const next = await api<DownloadStatus>("download_status");
        if (disposed || starting.current || epoch !== statusEpoch.current)
          return;
        if (
          next.task_id &&
          next.task_id === latestStatus.current.task_id &&
          ["complete", "error", "cancelled"].includes(
            latestStatus.current.stage,
          ) &&
          active(next)
        )
          return;
        latestStatus.current = next;
        setStatus(next);
        callbacks.current.onStatusChange(next);
        callbacks.current.onBusyChange(active(next));
        if (active(next)) completed.current = "";
        if (
          (next.stage === "complete" ||
            (next.stage === "error" &&
              [
                "instance_rename",
                "instance_import",
                "instance_delete",
                "instance_restore",
                "resource_download",
                "resource_update",
                "resource_update_restore",
              ].includes(next.kind || ""))) &&
          next.kind !== "resource_save" &&
          next.kind !== "launcher_logs" &&
          next.version &&
          completed.current !==
            (next.task_id ||
              `${next.root_id || next.root_path || ""}:${next.version}`)
        ) {
          completed.current =
            next.task_id ||
            `${next.root_id || next.root_path || ""}:${next.version}`;
          if (
            next.kind === "instance_rename" ||
            next.kind === "instance_import" ||
            next.kind === "instance_delete" ||
            next.kind === "instance_restore" ||
            next.kind === "resource_download" ||
            next.kind === "resource_update" ||
            next.kind === "resource_update_restore" ||
            next.kind === "install" ||
            !next.root_id ||
            next.root_id === context.current.rootId
          )
            if (next.kind !== "instance_export")
              await callbacks.current.onInstalled();
        }
      } catch (e) {
        if (
          !disposed &&
          epoch === statusEpoch.current &&
          context.current.visible
        )
          setError(String(e));
      } finally {
        polling = false;
      }
    }
    void poll();
    const timer = window.setInterval(poll, 1000);
    let unlisten: (() => void) | undefined;
    if (native) {
      void listen("task_changed", () => void poll())
        .then((stop) => {
          if (disposed) stop();
          else unlisten = stop;
        })
        .catch(() => {});
    }
    return () => {
      disposed = true;
      clearInterval(timer);
      unlisten?.();
    };
  }, [api, native]);
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
      title: t("download.release"),
      entries: catalog.filter(
        (e) => e.kind === "release" && !aprilVersions.has(e.id),
      ),
    },
    {
      id: "snapshot",
      title: t("download.preview"),
      entries: catalog.filter(
        (e) => e.kind === "snapshot" && !aprilVersions.has(e.id),
      ),
    },
    {
      id: "old",
      title: t("download.ancient"),
      entries: catalog.filter(
        (e) =>
          !["release", "snapshot"].includes(e.kind) && !aprilVersions.has(e.id),
      ),
    },
    {
      id: "april",
      title: t("download.april"),
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
        disabled={busy || gameBusy || !rootAvailable}
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
                ? t("download.latestRelease")
                : t("download.latestPreview")
              : kindName(entry.kind)}
            {t("download.published")}{" "}
            {formatDate(new Date(entry.release_time), {
              year: "numeric",
              month: "numeric",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
              hour12: false,
            })}
          </small>
        </span>
        {ids.has(entry.id) && <span className="tag">{t("ui.installed")}</span>}
      </button>
    );
  }
  async function start(options: InstallOptions) {
    if (
      starting.current ||
      context.current !== renderedContext ||
      !context.current.visible ||
      !choice ||
      gameBusy ||
      busy ||
      !native ||
      !rootAvailable ||
      !rootId ||
      installNameError(options.name, installed)
    )
      return;
    const source = context.current;
    const targetRootId = rootId;
    const targetVersion = choice.id;
    starting.current = true;
    const epoch = ++statusEpoch.current;
    let accepted = false;
    setWorking(true);
    setError("");
    callbacks.current.onBusyChange(true);
    try {
      const taskId = await api<string>("download_start", {
        id: targetVersion,
        rootId: targetRootId,
        name: options.name,
        components: options.components,
      });
      accepted = true;
      if (
        !mounted.current ||
        epoch !== statusEpoch.current ||
        context.current.api !== source.api
      )
        return;
      completed.current = "";
      const submitted: DownloadStatus = {
        ...idleDownload,
        stage: "preparing",
        phase: "metadata",
        message: t("download.preparing"),
        task_id: taskId,
        root_id: targetRootId,
        version: options.name,
        progress: 0,
        can_cancel: true,
      };
      latestStatus.current = submitted;
      setStatus(submitted);
      callbacks.current.onStatusChange(submitted);
      if (source === context.current && source.visible) {
        setChoice(null);
        callbacks.current.onTaskStart();
      }
      const next = await api<DownloadStatus>("download_status");
      if (
        !mounted.current ||
        epoch !== statusEpoch.current ||
        next.task_id !== taskId ||
        context.current.api !== source.api
      )
        return;
      latestStatus.current = next;
      setStatus(next);
      callbacks.current.onStatusChange(next);
      callbacks.current.onBusyChange(active(next));
    } catch (e) {
      if (
        mounted.current &&
        epoch === statusEpoch.current &&
        source === context.current
      )
        setError(String(e));
      if (mounted.current && epoch === statusEpoch.current && !accepted)
        callbacks.current.onBusyChange(active(latestStatus.current));
    } finally {
      if (epoch === statusEpoch.current) {
        starting.current = false;
        if (mounted.current) setWorking(false);
      }
    }
  }
  return (
    <>
      {gameBusy && <div className="auth-notice">{t("download.gameBusy")}</div>}
      {error && (
        <div className="error-banner" role="alert">
          <TriangleAlert size={17} />
          <span>{error}</span>
          <button
            className="icon-button"
            onClick={() => setError("")}
            aria-label={t("ui.closeNotice")}
          >
            <X size={15} />
          </button>
        </div>
      )}
      {choice && section === "minecraft" ? (
        <InstallSelection
          key={`${rootId}:${choice.id}`}
          api={api}
          rootId={rootId}
          version={choice.id}
          native={native}
          disabled={busy || gameBusy || !rootAvailable}
          installed={installed}
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
              <p className="muted">{t("download.catalogUnavailable")}</p>
            </section>
          ) : (
            <>
              <section className="ce-card ce-catalog-latest">
                <div className="ce-card-title">{t("ui.latest")}</div>
                {loading ? (
                  <div className="download-empty">
                    <LoaderCircle className="spin" size={22} />
                    <p>{t("download.catalogLoading")}</p>
                  </div>
                ) : latest.length ? (
                  latest.map((entry) => versionRow(entry, true))
                ) : (
                  <div className="download-empty">
                    <p>
                      {native
                        ? t("download.catalogEmpty")
                        : t("download.catalogDesktop")}
                    </p>
                    <button
                      className="ce-button"
                      disabled={!native || loading}
                      onClick={() => void loadCatalog(true)}
                    >
                      <RefreshCw size={14} />
                      {t("ui.reload")}
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
                      {group.title} ({formatNumber(group.entries.length)})
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
                        <p className="muted">{t("ui.noVersions")}</p>
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

// Filter values are provider/UI protocol IDs. Only their rendered labels
// change language; translating the values would change request routing.
const resourceLabelKeys: Record<string, MessageKey> = {
  模组: "resources.mods",
  整合包: "resources.modpacks",
  数据包: "resources.datapacks",
  资源包: "nav.resourcepacks",
  光影包: "nav.shaderpacks",
  世界: "resources.worlds",
  收藏夹: "resources.favorites",
};
const filterLabel = (value: string) =>
  value === "全部"
    ? t("ui.all")
    : value === "默认"
      ? t("common.default")
      : value === "任意"
        ? t("ui.any")
        : value === "更新时间"
          ? t("ui.updated")
          : value === "下载量"
            ? t("ui.downloads")
            : value;

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
  const displayLabel = t(resourceLabelKeys[label]);
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
    library: t("category.library"),
    optimization: t("category.optimization"),
    utility: t("category.utility"),
    decoration: t("category.decoration"),
    adventure: t("category.adventure"),
    technology: t("category.technology"),
    worldgen: t("category.worldgen"),
    storage: t("category.storage"),
    equipment: t("category.equipment"),
    magic: t("category.magic"),
    management: t("nav.manage"),
  };
  const tags = [
    ...new Set(
      hits
        .flatMap((hit) => hit.display_categories)
        .filter((value) => !loaderNames[value]),
    ),
  ];
  const downloads = (value: number) =>
    formatNumber(value, { notation: "compact", maximumFractionDigits: 1 });
  const updated = (value: string) => formatRelativeDate(value);
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
          placeholder={t("ui.searchType", { type: displayLabel })}
          aria-label={t("ui.searchType", { type: displayLabel })}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button className="ce-button" type="submit">
          {t("ui.search")}
        </button>
      </form>
      <section className="ce-card ce-community-filters">
        <label className="ce-filter-field">
          {t("ui.source")}
          <select
            className="ce-field"
            value={source}
            onChange={(e) => setSource(e.target.value)}
          >
            {["全部", "Modrinth", "CurseForge"].map((v) => (
              <option key={v} value={v} disabled={v === "CurseForge"}>
                {v === "CurseForge"
                  ? t("download.curseforgeUnavailable")
                  : filterLabel(v)}
              </option>
            ))}
          </select>
        </label>
        <label className="ce-filter-field">
          {t("ui.tags")}
          <select
            className="ce-field"
            value={tag}
            onChange={(e) => setTag(e.target.value)}
          >
            <option>{t("ui.all")}</option>
            {tags.map((value) => (
              <option key={value} value={value}>
                {categoryNames[value] || value}
              </option>
            ))}
          </select>
        </label>
        <label className="ce-filter-field">
          {t("ui.sort")}
          <select
            className="ce-field"
            value={sort}
            onChange={(e) => setSort(e.target.value)}
          >
            {["默认", "下载量", "更新时间"].map((v) => (
              <option key={v} value={v}>
                {filterLabel(v)}
              </option>
            ))}
          </select>
        </label>
        <button
          className="icon-button ce-filter-reset"
          aria-label={t("ui.resetFilters")}
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
          {t("ui.version")}
          <select
            className="ce-field"
            value={version}
            onChange={(e) => setVersion(e.target.value)}
          >
            <option>{t("ui.any")}</option>
            {availableVersions.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        <label className="ce-filter-field">
          {t("ui.loader")}
          <select
            className="ce-field"
            value={loader}
            onChange={(e) => setLoader(e.target.value)}
          >
            {["任意", "Fabric", "Forge", "NeoForge", "Quilt"].map((v) => (
              <option key={v} value={v}>
                {filterLabel(v)}
              </option>
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
            <p>{t("download.loadingType", { type: displayLabel })}</p>
          </div>
        ) : error ? (
          <div className="download-empty" role="alert">
            <TriangleAlert size={24} />
            <p>{error}</p>
            <button className="ce-button" onClick={search}>
              {t("ui.retry")}
            </button>
          </div>
        ) : !hits.length ? (
          <div className="download-empty">
            <Search size={30} strokeWidth={1.3} />
            <p>
              {label === "世界"
                ? t("download.worldsUnavailable")
                : t("download.noMatching", { type: displayLabel })}
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
                aria-label={t("ui.viewDetails", { name: hit.title })}
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
                    <span title={formatDate(new Date(hit.date_modified))}>
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
