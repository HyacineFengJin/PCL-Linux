import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUpToLine,
  Box,
  ChevronDown,
  Copy,
  Download,
  Globe,
  Heart,
  Languages,
  ListFilter,
  LoaderCircle,
  RefreshCw,
} from "lucide-react";
import { Collapse } from "./Collapse";
import type { Api, Instance } from "./types";
import { ResourceInstall } from "./ResourceInstall";
import type { ResourceInstallRequest } from "./resourceInstallPlan";
import "./resource-details.css";

export type ResourceSummary = {
  project_id: string;
  title: string;
  description: string;
  icon_url: string | null;
  categories: string[];
  display_categories: string[];
  versions: string[];
  downloads?: number;
  date_modified?: string;
  project_type?: string;
  source?: string;
  file_name?: string;
  local_version?: string;
  local_path?: string;
  enabled?: boolean;
  local_minecraft_version?: string;
  local_loader?: string;
};

type Project = Omit<ResourceSummary, "versions"> & {
  game_versions: string[];
  loaders: string[];
  url: string;
};
type DependencyReference = {
  project_id: string | null;
  version_id: string | null;
  file_name: string | null;
  dependency_type: string;
};
type Version = {
  id: string;
  project_id: string;
  name: string;
  version_number: string;
  game_versions: string[];
  loaders: string[];
  date_published: string;
  downloads: number;
  version_type: string;
  files: { filename: string; size: number; primary: boolean }[];
  dependencies: DependencyReference[];
};
type Details = {
  project: Project;
  versions: Version[];
  versions_truncated: boolean;
};
type Dependencies = {
  version_id: string;
  dependencies: (DependencyReference & { project: Project | null })[];
  truncated: boolean;
};
type DependencyState = {
  data?: Dependencies;
  loading?: boolean;
  error?: string;
};
type VersionGroup = {
  id: string;
  title: string;
  game: string;
  loader: string;
  versions: Version[];
};

const loaderNames: Record<string, string> = {
  fabric: "Fabric",
  forge: "Forge",
  neoforge: "NeoForge",
  quilt: "Quilt",
  liteloader: "LiteLoader",
  iris: "Iris",
  optifine: "OptiFine",
  minecraft: "Minecraft",
};
const categoryNames: Record<string, string> = {
  library: "支持库",
  technology: "科技",
  adventure: "冒险",
  optimization: "性能优化",
  utility: "实用",
  decoration: "装饰",
  equipment: "装备与工具",
  magic: "魔法",
  storage: "仓储",
  transportation: "管道与物流",
  worldgen: "世界生成",
  multiplayer: "多人",
  lightweight: "轻量整合",
  kitchen_sink: "大型整合",
  "game-mechanics": "游戏机制",
  management: "管理",
  cursed: "趣味",
  food: "食物",
  mobs: "生物",
  social: "社交",
  visual: "视觉",
  combat: "战斗",
};
const loaderName = (value: string) => loaderNames[value.toLowerCase()] ?? value;
const isLoader = (value: string) =>
  Object.hasOwn(loaderNames, value.toLowerCase());
const count = (value?: number) => {
  if (value === undefined || !Number.isFinite(value)) return "—";
  if (value >= 100_000_000)
    return `${Number((value / 100_000_000).toFixed(2))} 亿`;
  if (value >= 100_000) return `${Number((value / 10_000).toFixed(1))} 万`;
  return value.toLocaleString("zh-CN");
};
const relativeDate = (value?: string) => {
  if (!value) return "—";
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return "—";
  const seconds = Math.max(0, Math.floor((Date.now() - date) / 1000));
  for (const [unit, label] of [
    [31_536_000, "年"],
    [2_592_000, "个月"],
    [604_800, "周"],
    [86_400, "天"],
    [3_600, "小时"],
    [60, "分钟"],
  ] as const) {
    if (seconds >= unit) return `${Math.floor(seconds / unit)} ${label}前`;
  }
  return "刚刚";
};
const compareVersions = (a: string, b: string) =>
  b.localeCompare(a, "en", { numeric: true });
const stableGame = (value: string) => /^\d+(?:\.\d+)+$/.test(value);
const gameFamily = (value: string) =>
  value
    .match(/^(\d+(?:\.\d+)+)/)?.[1]
    .split(".")
    .slice(0, 2)
    .join(".") || "快照版";
const unique = (values: string[]) => [...new Set(values)];
const fileSize = (value: number) =>
  value < 1_048_576
    ? `${Number((value / 1024).toFixed(1))} KB`
    : `${Number((value / 1_048_576).toFixed(1))} MB`;

function versionGroups(
  versions: Version[],
  multipleLoaders: boolean,
  pack: boolean,
): VersionGroup[] {
  const groups = new Map<string, VersionGroup>();
  for (const version of versions) {
    const games = version.game_versions.length
      ? version.game_versions
      : ["未标明游戏版本"];
    const loaders =
      multipleLoaders && !pack
        ? version.loaders.length
          ? version.loaders
          : [""]
        : [""];
    for (const game of games) {
      for (const loader of loaders) {
        const id = `${loader}\u0000${game}`;
        const group = groups.get(id) ?? {
          id,
          game,
          loader,
          title: [loaderName(loader), game].filter(Boolean).join(" "),
          versions: [],
        };
        group.versions.push(version);
        groups.set(id, group);
      }
    }
  }
  return [...groups.values()].sort(
    (a, b) =>
      compareVersions(a.game, b.game) || a.loader.localeCompare(b.loader),
  );
}

function ProjectIcon({
  url,
  local = false,
}: {
  url: string | null | undefined;
  local?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  let safe = false;
  try {
    const parsed = new URL(url ?? "");
    safe =
      parsed.protocol === "https:" && parsed.hostname === "cdn.modrinth.com";
  } catch {
    /* Missing icons use the neutral resource symbol. */
  }
  safe ||=
    local &&
    !!url &&
    url.length < 2 * 1024 * 1024 &&
    /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(url);
  return (
    <span className="rd-project-icon">
      {safe && !failed ? (
        <img src={url!} alt="" onError={() => setFailed(true)} />
      ) : (
        <Box size={34} strokeWidth={1.5} />
      )}
    </span>
  );
}

function ReleaseIcon({ type }: { type: string }) {
  const label = type === "beta" ? "B" : type === "alpha" ? "A" : "R";
  return (
    <span
      className={`rd-release-icon rd-release-${label.toLowerCase()}`}
      aria-label={
        type === "beta" ? "测试版" : type === "alpha" ? "开发版" : "正式版"
      }
    >
      {label}
    </span>
  );
}

export function ResourceDetails({
  api,
  resource,
  onNotify,
  scopeKey,
  selectedInstance,
  native,
  disabled,
  onTaskStart,
}: {
  api: Api;
  resource: ResourceSummary;
  onNotify: (message: string) => void;
  scopeKey: string;
  selectedInstance: Instance | null;
  native: boolean;
  disabled: boolean;
  onTaskStart: (id: string) => void;
}) {
  const [details, setDetails] = useState<Details | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [dependencyRetry, setDependencyRetry] = useState(0);
  const [gameFilter, setGameFilter] = useState("全部");
  const [loaderFilter, setLoaderFilter] = useState("全部");
  const [expanded, setExpanded] = useState<string[]>([]);
  const [selected, setSelected] = useState<{
    version: Version;
    title: string;
  } | null>(null);
  const [selectedOpen, setSelectedOpen] = useState(true);
  const [fileChoice, setFileChoice] = useState<{
    version: string;
    filename: string;
  } | null>(null);
  const [installChoice, setInstallChoice] = useState<{
    context: object;
    request: ResourceInstallRequest;
  } | null>(null);
  const [dependencies, setDependencies] = useState<
    Record<string, DependencyState>
  >({});
  const [dependencyOpen, setDependencyOpen] = useState<Record<string, boolean>>(
    {},
  );
  const [packChoice, setPackChoice] = useState<Version | null>(null);
  const [instanceName, setInstanceName] = useState("");
  const [nameError, setNameError] = useState("");
  const requestIdentity = useRef("");
  const requestGeneration = useRef(0);
  const dependencyRequests = useRef(new Set<string>());
  const nameInput = useRef<HTMLInputElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const selectedCard = useRef<HTMLElement>(null);
  const installButton = useRef<HTMLButtonElement>(null);
  const source = resource.source ?? "Modrinth";
  const local = source.toLowerCase() === "local";
  const modrinth =
    source.toLowerCase() === "modrinth" && Boolean(resource.project_id);
  const pack =
    (details?.project.project_type ?? resource.project_type) === "modpack";
  const installable =
    modrinth &&
    ["mod", "resourcepack", "shader"].includes(
      details?.project.project_type ?? resource.project_type ?? "",
    );
  const selectedFile =
    selected?.version.files.find(
      (file) =>
        fileChoice?.version === selected.version.id &&
        fileChoice.filename === file.filename,
    ) ??
    selected?.version.files.find((file) => file.primary) ??
    selected?.version.files[0];
  const contextKey = JSON.stringify([
    scopeKey,
    source,
    resource.project_id,
    retry,
    selectedInstance?.id,
    selectedInstance?.minecraft_version,
    selectedInstance?.loader,
    selected?.version.id,
    selectedFile?.filename,
  ]);
  // Equal IDs can reappear after browsing another root. The owner object also
  // invalidates saved actions and an open confirmation when that scope changes.
  const installationContext = useRef({ api, contextKey });
  if (
    installationContext.current.api !== api ||
    installationContext.current.contextKey !== contextKey
  )
    installationContext.current = { api, contextKey };
  const renderedInstallationContext = installationContext.current;
  const admission = useRef({ native, disabled });
  admission.current = { native, disabled };
  const project = details?.project;
  const title = project?.title ?? resource.title;
  const loaders = project?.loaders ?? resource.categories.filter(isLoader);
  const games = project?.game_versions ?? resource.versions;
  const releases = games.filter(stableGame).sort(compareVersions);
  const supportedGames =
    releases.length > 1 ? `${releases.at(-1)}+` : releases[0] || games[0] || "";
  const categories = (
    project?.display_categories ?? resource.display_categories
  ).filter((item) => !isLoader(item));
  const multipleLoaders = loaders.length > 1;
  const groups = useMemo(
    () => versionGroups(details?.versions ?? [], multipleLoaders, pack),
    [details, multipleLoaders, pack],
  );
  const filters = unique(
    games.map((game) => (pack ? game : gameFamily(game))),
  ).sort((a, b) =>
    a === "快照版" ? 1 : b === "快照版" ? -1 : compareVersions(a, b),
  );
  const shownGroups = groups
    .filter(
      (group) =>
        ((gameFilter === "全部" && (pack || stableGame(group.game))) ||
          (gameFilter === "快照版" && !stableGame(group.game)) ||
          (gameFilter !== "全部" &&
            gameFilter !== "快照版" &&
            (pack
              ? group.game === gameFilter
              : gameFamily(group.game) === gameFilter))) &&
        (loaderFilter === "全部" ||
          group.loader === loaderFilter ||
          (!group.loader &&
            group.versions.some((version) =>
              version.loaders.includes(loaderFilter),
            ))),
    )
    .map((group) => ({
      ...group,
      versions: group.versions.filter(
        (version) =>
          loaderFilter === "全部" || version.loaders.includes(loaderFilter),
      ),
    }));
  const providerUrl =
    project?.url ??
    (modrinth
      ? `https://modrinth.com/${resource.project_type === "modpack" ? "modpack" : resource.project_type === "resourcepack" ? "resourcepack" : resource.project_type === "shader" ? "shader" : "mod"}/${encodeURIComponent(resource.project_id)}`
      : "");

  useEffect(() => {
    const identity = `${source}:${resource.project_id}:${++requestGeneration.current}`;
    requestIdentity.current = identity;
    dependencyRequests.current = new Set();
    setDetails(null);
    setError("");
    setExpanded([]);
    setDependencies({});
    setDependencyOpen({});
    setSelected(null);
    setFileChoice(null);
    setInstallChoice(null);
    setPackChoice(null);
    setGameFilter("全部");
    setLoaderFilter("全部");
    if (!modrinth) {
      setLoading(false);
      return;
    }
    let live = true;
    setLoading(true);
    api<Details>("resource_details", { projectId: resource.project_id })
      .then((next) => {
        if (!live) return;
        setDetails(next);
        const groupList = versionGroups(
          next.versions,
          next.project.loaders.length > 1,
          next.project.project_type === "modpack",
        );
        if (
          next.project.loaders.length <= 1 ||
          next.project.project_type === "modpack"
        )
          setExpanded(
            (
              pack
                ? groupList[0]
                : groupList.find((group) => stableGame(group.game))
            )
              ? [
                  (pack
                    ? groupList[0]
                    : groupList.find((group) => stableGame(group.game)))!.id,
                ]
              : [],
          );
      })
      .catch((e) => {
        if (live) setError(String(e));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
      if (requestIdentity.current === identity) requestIdentity.current = "";
    };
  }, [api, resource.project_id, source, modrinth, retry]);

  const visibleDependencyVersions = unique(
    [
      ...shownGroups
        .filter((group) => expanded.includes(group.id))
        .map((group) => group.versions[0]?.id ?? ""),
      selected?.version.id ?? "",
    ].filter(Boolean),
  );
  const dependencyKey = visibleDependencyVersions.join(",");
  useEffect(() => {
    if (!modrinth || !details) return;
    const identity = requestIdentity.current;
    for (const versionId of dependencyKey.split(",").filter(Boolean)) {
      if (dependencyRequests.current.has(versionId)) continue;
      dependencyRequests.current.add(versionId);
      const version = details.versions.find((entry) => entry.id === versionId);
      if (
        !version?.dependencies.some((dependency) =>
          ["required", "optional"].includes(dependency.dependency_type),
        )
      ) {
        setDependencies((state) => ({
          ...state,
          [versionId]: {
            data: { version_id: versionId, dependencies: [], truncated: false },
          },
        }));
        continue;
      }
      setDependencies((state) => ({
        ...state,
        [versionId]: { loading: true },
      }));
      api<Dependencies>("resource_dependencies", { versionId })
        .then((data) => {
          if (requestIdentity.current === identity)
            setDependencies((state) => ({ ...state, [versionId]: { data } }));
        })
        .catch((e) => {
          if (requestIdentity.current === identity)
            setDependencies((state) => ({
              ...state,
              [versionId]: { error: String(e) },
            }));
        });
    }
  }, [api, dependencyKey, details, modrinth, dependencyRetry]);

  useEffect(() => {
    if (!packChoice) return;
    previouslyFocused.current = document.activeElement as HTMLElement;
    nameInput.current?.focus();
    nameInput.current?.select();
    return () => {
      previouslyFocused.current?.focus();
    };
  }, [packChoice]);

  async function openLink(url: string) {
    if (!url) {
      onNotify(`${source} 详情接口尚未开放`);
      return;
    }
    try {
      await api("resource_open_link", { url });
    } catch (e) {
      onNotify(String(e));
    }
  }
  async function copy(value: string, label: string) {
    if (!value) {
      onNotify("该资源尚未匹配来源链接");
      return;
    }
    try {
      await navigator.clipboard.writeText(value);
      onNotify(`已复制${label}`);
    } catch {
      onNotify("无法访问剪贴板，请检查系统权限");
    }
  }
  function chooseVersion(version: Version, groupTitle: string) {
    setSelected({ version, title: groupTitle });
    setFileChoice(null);
    setInstallChoice(null);
    setSelectedOpen(true);
    if (pack) {
      setInstanceName(
        title
          .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
          .trim()
          .slice(0, 100),
      );
      setNameError("");
      setPackChoice(version);
    } else {
      window.requestAnimationFrame(() =>
        selectedCard.current?.scrollIntoView({
          block: "nearest",
          behavior: "smooth",
        }),
      );
    }
  }
  function versionRow(version: Version, groupTitle: string) {
    const dependencyCount = version.dependencies.filter(
      (dependency) => dependency.dependency_type === "required",
    ).length;
    return (
      <button
        className={`rd-version-row ${selected?.version.id === version.id ? "is-selected" : ""}`}
        key={version.id}
        onClick={() => chooseVersion(version, groupTitle)}
      >
        <ReleaseIcon type={version.version_type} />
        <span className="rd-version-copy">
          <span className="rd-version-title">
            {version.name ||
              version.files.find((file) => file.primary)?.filename ||
              version.version_number}
          </span>
          <span className="rd-version-meta">
            {version.version_number}
            {dependencyCount > 0 && `  |  ${dependencyCount} 项前置`} | 下载{" "}
            {count(version.downloads)} 次 | 更新于{" "}
            {relativeDate(version.date_published)}
            {version.version_type === "beta"
              ? "  |  测试版"
              : version.version_type === "alpha"
                ? "  |  开发版"
                : ""}
          </span>
        </span>
        <Download size={17} className="rd-row-download" aria-hidden="true" />
      </button>
    );
  }
  function dependencySections(version: Version, context: string) {
    const state = dependencies[version.id];
    const references =
      state?.data?.dependencies ??
      version.dependencies.map((reference) => ({
        ...reference,
        project: null,
      }));
    return (
      <>
        {["required", "optional"].map((kind) => {
          const entries = references.filter(
            (dependency) => dependency.dependency_type === kind,
          );
          if (!entries.length) return null;
          const key = `${context}:${kind}`;
          const open = dependencyOpen[key] !== false;
          return (
            <section className="rd-dependencies" key={kind}>
              <button
                className="rd-dependency-toggle"
                onClick={() =>
                  setDependencyOpen((value) => ({ ...value, [key]: !open }))
                }
                aria-expanded={open}
              >
                <strong>
                  {kind === "required" ? "必要前置资源" : "可选前置资源"}（
                  {entries.length}）
                </strong>
                <ChevronDown size={16} className={open ? "is-open" : ""} />
              </button>
              <Collapse open={open}>
                {entries.map((dependency, index) => (
                  <div
                    className="rd-dependency-row"
                    key={`${dependency.project_id ?? dependency.version_id ?? dependency.file_name}:${index}`}
                  >
                    <ProjectIcon url={dependency.project?.icon_url} />
                    <div className="rd-dependency-copy">
                      <button
                        className="rd-dependency-name"
                        disabled={!dependency.project}
                        onClick={() =>
                          void openLink(dependency.project?.url ?? "")
                        }
                      >
                        {dependency.project?.title ??
                          dependency.file_name ??
                          dependency.project_id ??
                          dependency.version_id ??
                          "未标明名称的前置资源"}
                      </button>
                      {dependency.project ? (
                        <>
                          <div className="rd-description">
                            {dependency.project.display_categories
                              .filter((category) => !isLoader(category))
                              .map((category) => (
                                <span className="rd-category" key={category}>
                                  {categoryNames[category] ?? category}
                                </span>
                              ))}
                            {dependency.project.description}
                          </div>
                          <div className="rd-dependency-meta">
                            <span>
                              <Download size={12} />
                              {count(dependency.project.downloads)}
                            </span>
                            <span>
                              <ArrowUpToLine size={12} />
                              {relativeDate(dependency.project.date_modified)}
                            </span>
                            <span>
                              <Globe size={12} />
                              Modrinth
                            </span>
                          </div>
                        </>
                      ) : (
                        <div className="rd-description">
                          {state?.loading
                            ? "正在读取前置信息…"
                            : "该前置资源的详情暂不可用"}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </Collapse>
            </section>
          );
        })}
        {state?.error && (
          <div className="rd-inline-status" role="status">
            前置信息读取失败：{state.error}
            <button
              className="ce-text-button"
              onClick={() => {
                dependencyRequests.current.delete(version.id);
                setDependencyRetry((value) => value + 1);
              }}
            >
              重试
            </button>
          </div>
        )}
        {state?.data?.truncated && (
          <div className="rd-inline-status">
            前置资源较多，当前显示前 32 项。
          </div>
        )}
      </>
    );
  }

  return (
    <div className="rd-page">
      <section className="ce-card rd-summary">
        <div className="rd-summary-main">
          <ProjectIcon
            url={project?.icon_url ?? resource.icon_url}
            local={local}
          />
          <div className="rd-summary-copy">
            <h1>{title}</h1>
            <div className="rd-description">
              {categories.map((category) => (
                <span className="rd-category" key={category}>
                  {categoryNames[category] ?? category}
                </span>
              ))}
              {project?.description ?? resource.description}
            </div>
            <div className="rd-summary-meta">
              <span title={games.join(", ")}>
                <ListFilter size={12} />
                {local
                  ? [resource.local_loader, resource.local_minecraft_version]
                      .filter(Boolean)
                      .join(" ") || "本地模组"
                  : `${loaders.map(loaderName).join(" / ")} ${supportedGames}`}
              </span>
              <span>
                <Download size={12} />
                {count(project?.downloads ?? resource.downloads)}
              </span>
              <span title={project?.date_modified ?? resource.date_modified}>
                <ArrowUpToLine size={12} />
                {relativeDate(project?.date_modified ?? resource.date_modified)}
              </span>
              <span>
                <Globe size={12} />
                {local ? "本地文件" : source}
              </span>
            </div>
          </div>
        </div>
        <div className="rd-summary-actions">
          <button onClick={() => openLink(providerUrl)}>
            <Globe size={15} />
            {source === "local" ? "来源页面" : source}
          </button>
          <button onClick={() => openLink("https://www.mcmod.cn/")}>
            <Globe size={15} />
            MC 百科
          </button>
          <button onClick={() => copy(title, "名称")}>
            <Copy size={15} />
            复制名称
          </button>
          <button onClick={() => copy(providerUrl, "链接")}>
            <Copy size={15} />
            复制链接
          </button>
          <button onClick={() => onNotify("简介翻译尚未开放")}>
            <Languages size={15} />
            翻译简介
          </button>
          <button onClick={() => onNotify("收藏管理尚未开放")}>
            <Heart size={15} />
            收藏
          </button>
        </div>
      </section>
      {local ? (
        <>
          <section className="ce-card rd-version-group">
            <button
              className="rd-group-toggle"
              onClick={() => setSelectedOpen((value) => !value)}
              aria-expanded={selectedOpen}
            >
              <strong>
                所选版本：
                {[resource.local_loader, resource.local_minecraft_version]
                  .filter(Boolean)
                  .join(" ") ||
                  resource.local_version ||
                  "本地文件"}
              </strong>
              <ChevronDown
                size={16}
                className={selectedOpen ? "is-open" : ""}
              />
            </button>
            <Collapse open={selectedOpen}>
              <div className="rd-group-body">
                <div className="rd-version-row">
                  <ReleaseIcon type="release" />
                  <div className="rd-version-copy">
                    <span className="rd-version-title">
                      {resource.file_name ?? title}
                    </span>
                    <span className="rd-version-meta">
                      {resource.local_version || "模组版本未标明"}
                      {resource.enabled !== undefined &&
                        `  |  ${resource.enabled ? "已启用" : "已禁用"}`}
                    </span>
                  </div>
                </div>
                {resource.local_path && (
                  <div className="rd-local-path">
                    文件位置：{resource.local_path}
                  </div>
                )}
              </div>
            </Collapse>
          </section>
          <section className="ce-card rd-state">
            <p>版本目录尚未匹配</p>
            <small>当前显示本地文件信息。来源与前置资源尚未匹配。</small>
          </section>
        </>
      ) : (
        <>
          <section
            className={`ce-card rd-filters ${pack ? "rd-pack-filters" : ""}`}
          >
            <div className="rd-filter-row">
              {!pack && <span>实例筛选:</span>}
              {["全部", ...filters].map((value) => (
                <button
                  key={value}
                  className={gameFilter === value ? "is-active" : ""}
                  onClick={() => setGameFilter(value)}
                >
                  {value}
                </button>
              ))}
            </div>
            {!pack && (
              <div className="rd-filter-row">
                <span>模组加载器筛选:</span>
                {["全部", ...unique(loaders)].map((value) => (
                  <button
                    key={value}
                    className={loaderFilter === value ? "is-active" : ""}
                    onClick={() => setLoaderFilter(value)}
                  >
                    {value === "全部" ? value : loaderName(value)}
                  </button>
                ))}
              </div>
            )}
          </section>
          {loading && (
            <section className="ce-card rd-state" role="status">
              <LoaderCircle size={18} className="spin" />
              <p>正在读取资源详情…</p>
            </section>
          )}
          {error && (
            <section className="ce-card rd-state" role="status">
              <p>{error}</p>
              <button
                className="ce-button"
                onClick={() => setRetry((value) => value + 1)}
              >
                <RefreshCw size={14} />
                重新读取
              </button>
            </section>
          )}
          {!modrinth && (
            <section className="ce-card rd-state">
              <p>{source} 详情接口尚未开放</p>
              <small>版本与前置资源将在来源接口接入后显示。</small>
            </section>
          )}
          {selected && (
            <section
              className="ce-card rd-version-group rd-selected"
              ref={selectedCard}
            >
              <button
                className="rd-group-toggle"
                onClick={() => setSelectedOpen((value) => !value)}
                aria-expanded={selectedOpen}
              >
                <strong>所选版本：{selected.title}</strong>
                <ChevronDown
                  size={16}
                  className={selectedOpen ? "is-open" : ""}
                />
              </button>
              <Collapse open={selectedOpen}>
                <div className="rd-group-body">
                  {dependencySections(selected.version, "selected")}
                  <div className="rd-version-list-label">版本列表</div>
                  {versionRow(selected.version, selected.title)}
                  <div className="rd-selected-files">
                    {selected.version.files.map((file, index) =>
                      selected.version.files.length > 1 ? (
                        <button
                          key={`${file.filename}:${index}`}
                          className="ce-text-button rd-selected-file"
                          type="button"
                          aria-pressed={
                            selectedFile?.filename === file.filename
                          }
                          onClick={() => {
                            if (
                              installationContext.current !==
                              renderedInstallationContext
                            )
                              return;
                            setFileChoice({
                              version: selected.version.id,
                              filename: file.filename,
                            });
                            setInstallChoice(null);
                          }}
                        >
                          {file.filename}（{fileSize(file.size)}）
                        </button>
                      ) : (
                        <span key={`${file.filename}:${index}`}>
                          {file.filename}（{fileSize(file.size)}）
                        </span>
                      ),
                    )}
                  </div>
                  <div className="rd-selected-actions">
                    <button
                      className="ce-button primary"
                      onClick={() =>
                        pack
                          ? chooseVersion(selected.version, selected.title)
                          : onNotify("资源文件下载尚未开放")
                      }
                    >
                      <Download size={15} />
                      {pack ? "安装整合包" : "下载文件"}
                    </button>
                    {installable && (
                      <button
                        ref={installButton}
                        className="ce-button"
                        disabled={
                          !native ||
                          disabled ||
                          !scopeKey ||
                          !selectedInstance ||
                          !selectedFile
                        }
                        onClick={() => {
                          if (
                            installationContext.current !==
                              renderedInstallationContext ||
                            !admission.current.native ||
                            admission.current.disabled ||
                            !scopeKey ||
                            !selectedInstance ||
                            !selectedFile
                          )
                            return;
                          setInstallChoice({
                            context: renderedInstallationContext,
                            request: {
                              project_id: selected.version.project_id,
                              version_id: selected.version.id,
                              file_name: selectedFile.filename,
                            },
                          });
                        }}
                      >
                        <Download size={15} />
                        安装到实例
                      </button>
                    )}
                  </div>
                </div>
              </Collapse>
            </section>
          )}
          {shownGroups.map((group) => {
            const open = expanded.includes(group.id);
            const first = group.versions[0];
            const hasDependencies = first?.dependencies.some((dependency) =>
              ["required", "optional"].includes(dependency.dependency_type),
            );
            return (
              <section className="ce-card rd-version-group" key={group.id}>
                <button
                  className="rd-group-toggle"
                  onClick={() =>
                    setExpanded((current) =>
                      open
                        ? current.filter((id) => id !== group.id)
                        : [...current, group.id],
                    )
                  }
                  aria-expanded={open}
                >
                  <strong>{group.title}</strong>
                  <ChevronDown size={16} className={open ? "is-open" : ""} />
                </button>
                <Collapse open={open}>
                  <div className="rd-group-body">
                    {first && dependencySections(first, group.id)}
                    {hasDependencies && (
                      <div className="rd-version-list-label">版本列表</div>
                    )}
                    {group.versions.map((version) =>
                      versionRow(version, group.title),
                    )}
                  </div>
                </Collapse>
              </section>
            );
          })}
          {details && !loading && !error && !shownGroups.length && (
            <section className="ce-card rd-state">
              <p>没有符合筛选条件的版本</p>
            </section>
          )}
          {details?.versions_truncated && (
            <p className="rd-inline-status">
              版本较多，当前显示最新的 4000 个版本。
            </p>
          )}
        </>
      )}
      {installChoice?.context === renderedInstallationContext && (
        <ResourceInstall
          api={api}
          scopeKey={scopeKey}
          selectedInstance={selectedInstance}
          request={installChoice.request}
          contextKey={contextKey}
          native={native}
          disabled={disabled}
          onTaskStart={onTaskStart}
          onClose={() => {
            setInstallChoice(null);
            installButton.current?.focus();
          }}
          onNotify={onNotify}
        />
      )}
      {packChoice && (
        <div
          className="modal-shade rd-name-shade"
          onClick={() => setPackChoice(null)}
        >
          <form
            className="rd-name-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="rd-name-title"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setPackChoice(null);
              }
              if (event.key === "Tab") {
                const controls = [
                  ...event.currentTarget.querySelectorAll<HTMLElement>(
                    "input, button",
                  ),
                ];
                const first = controls[0],
                  last = controls[controls.length - 1];
                if (event.shiftKey && document.activeElement === first) {
                  event.preventDefault();
                  last?.focus();
                } else if (!event.shiftKey && document.activeElement === last) {
                  event.preventDefault();
                  first?.focus();
                }
              }
            }}
            onSubmit={(event) => {
              event.preventDefault();
              if (
                !instanceName.trim() ||
                /[\\/:*?"<>|\u0000-\u001f]/.test(instanceName) ||
                instanceName.trim() === "." ||
                instanceName.trim() === ".."
              ) {
                setNameError("请输入有效的实例名称");
                return;
              }
              setPackChoice(null);
              onNotify("整合包安装尚未开放，未创建实例");
            }}
          >
            <h2 id="rd-name-title">输入实例名称</h2>
            <input
              className="ce-field"
              aria-label="实例名称"
              ref={nameInput}
              maxLength={100}
              value={instanceName}
              onChange={(event) => {
                setInstanceName(event.target.value);
                setNameError("");
              }}
            />
            {nameError && (
              <div className="rd-name-error" role="alert">
                {nameError}
              </div>
            )}
            <div className="rd-name-actions">
              <button className="ce-button primary" type="submit">
                确定
              </button>
              <button
                className="ce-button"
                type="button"
                onClick={() => setPackChoice(null)}
              >
                取消
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
