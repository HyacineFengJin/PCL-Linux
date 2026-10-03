import { useEffect, useState } from "react";
import {
  Box,
  ChevronDown,
  Gauge,
  LoaderCircle,
  Pencil,
  RotateCcw,
  ScrollText,
  X,
} from "lucide-react";
import { Collapse } from "./Collapse";
import { loaderCandidates } from "./loaderCandidates";
import grassIcon from "./assets/game-icons/grass.png";
import forgeIcon from "./assets/game-icons/forge.png";
import neoForgeIcon from "./assets/game-icons/neoforge.png";
import type { Api, Instance } from "./types";
import "./instance-operations.css";

type ResourceFile = {
  name: string;
  path: string;
  file_name?: string;
  enabled: boolean;
};
type ResourceGroup = {
  files: ResourceFile[];
  loading: boolean;
  error: string;
};
const resourceKinds = [
  "mods",
  "resourcepacks",
  "shaderpacks",
  "screenshots",
  "saves",
] as const;
type ResourceKind = (typeof resourceKinds)[number];
type Resources = Record<ResourceKind, ResourceGroup>;
const unavailable = "此功能尚未开放";
const initialChecks: Record<string, boolean> = {
  game: true,
  gameSettings: true,
  gamePersonal: false,
  mods: true,
  packData: true,
  modSettings: true,
  maps: false,
  jeiPersonal: false,
  guidePersonal: false,
  resourcepacks: true,
  shaderpacks: true,
  screenshots: false,
  saves: false,
  server: false,
  other: false,
  launcher: false,
  bundleAssets: false,
  modrinth: false,
};

function emptyResources(): Resources {
  const result = {} as Resources;
  for (const kind of resourceKinds)
    result[kind] = { files: [], loading: true, error: "" };
  return result;
}

function VersionIcon({ name }: { name: string }) {
  const image =
    name === "Minecraft"
      ? grassIcon
      : name === "Forge"
        ? forgeIcon
        : name === "NeoForge"
          ? neoForgeIcon
          : null;
  return (
    <span className="ce-operation-version-icon" aria-hidden="true">
      {image ? (
        <img src={image} alt="" />
      ) : name === "Fabric" ? (
        <ScrollText size={21} />
      ) : name === "OptiFine" ? (
        <Gauge size={21} />
      ) : (
        <Box size={21} />
      )}
    </span>
  );
}

const modifyProviders = ["Forge", "NeoForge", "Fabric", "LabyMod", "OptiFine"];
const candidateProviders = modifyProviders.filter((name) => name !== "LabyMod");

function instanceChoices(instance: Instance): Record<string, string> {
  const [name, ...version] = instance.loader.split(" ");
  return name === "Vanilla" ? {} : { [name]: version.join(" ") || "已安装" };
}

function ModifyInstance({ instance, api }: { instance: Instance; api: Api }) {
  const loaderName = instance.loader.split(" ")[0];
  const originalChoices = instanceChoices(instance);
  const [choices, setChoices] = useState<Record<string, string>>(() =>
    instanceChoices(instance),
  );
  const [expanded, setExpanded] = useState<string | null>(null);
  const [catalogs, setCatalogs] = useState<Record<string, string[]>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState<string[]>(candidateProviders);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    setChoices(instanceChoices(instance));
    setExpanded(null);
  }, [instance.id, instance.loader, instance.minecraft_version]);

  useEffect(() => {
    let live = true;
    setCatalogs({});
    setErrors({});
    setLoading(candidateProviders);
    for (const name of candidateProviders) {
      loaderCandidates(api, name, instance.minecraft_version, refresh > 0)
        .then((values) => {
          if (live)
            setCatalogs((old) => ({ ...old, [name]: [...new Set(values)] }));
        })
        .catch((error) => {
          if (live) setErrors((old) => ({ ...old, [name]: String(error) }));
        })
        .finally(() => {
          if (live) setLoading((old) => old.filter((value) => value !== name));
        });
    }
    return () => {
      live = false;
    };
  }, [instance.minecraft_version, api, refresh]);

  function conflict(name: string) {
    const selected = Object.keys(choices);
    if (name === "OptiFine")
      return selected.find((value) =>
        ["NeoForge", "Fabric", "LabyMod", "Quilt"].includes(value),
      );
    return (
      selected.find((value) => value !== name && value !== "OptiFine") ||
      (name !== "Forge" && choices.OptiFine ? "OptiFine" : undefined)
    );
  }
  function restoreChoices() {
    setChoices(instanceChoices(instance));
    setExpanded(null);
  }
  function chooseVersion(name: string, version: string) {
    if (conflict(name)) return;
    setChoices((old) => ({ ...old, [name]: version }));
    setExpanded(null);
  }
  const changed = [
    ...new Set([...Object.keys(originalChoices), ...Object.keys(choices)]),
  ].some((name) => originalChoices[name] !== choices[name]);

  return (
    <div className="ce-instance-operation ce-instance-modify">
      <section className="ce-card instance-summary ce-operation-summary">
        <VersionIcon
          name={loaderName === "Vanilla" ? "Minecraft" : loaderName}
        />
        <div>
          <div>{instance.id}</div>
          <small>
            {instance.minecraft_version}
            {loaderName !== "Vanilla" && `  |  ${instance.loader}`}
          </small>
        </div>
      </section>
      <section className="ce-card ce-operation-version-row">
        <strong>Minecraft</strong>
        <div className="ce-operation-version-value">
          <VersionIcon name="Minecraft" />
          <span>{instance.minecraft_version}</span>
        </div>
        <button
          className="ce-operation-row-action ce-operation-edit-action"
          disabled
          title="Minecraft 版本修改尚未开放"
        >
          <Pencil size={14} />
          修改
        </button>
      </section>
      {modifyProviders.map((name) => {
        const selected = choices[name];
        const incompatible = conflict(name);
        const isExpanded = expanded === name;
        const versions = catalogs[name] || [];
        const isLoading = loading.includes(name);
        const unsupported = name === "LabyMod";
        const subtitle =
          selected ||
          (incompatible
            ? `与 ${incompatible} 不兼容`
            : unsupported
              ? "兼容版本目录尚未接入"
              : isLoading
                ? "正在获取…"
                : errors[name]
                  ? "暂不可用"
                  : versions.length
                    ? "可以选择"
                    : "没有可用版本");
        function versionRow(version: string, latest = false) {
          return (
            <button
              className={
                "ce-modify-candidate" +
                (selected === version ? " is-selected" : "")
              }
              disabled={!!incompatible}
              onClick={() => chooseVersion(name, version)}
              aria-pressed={selected === version}
            >
              <VersionIcon name={name} />
              <span>
                <strong>
                  {name === "OptiFine" ? version.replaceAll("_", " ") : version}
                </strong>
                {latest && <small>最新版本</small>}
              </span>
            </button>
          );
        }
        return (
          <section
            className={
              "ce-card ce-operation-loader-card" +
              (incompatible ? " is-incompatible" : "")
            }
            key={name}
          >
            <div className="ce-operation-loader-heading">
              <button
                className="ce-operation-version-toggle"
                disabled={!!incompatible || unsupported}
                onClick={() =>
                  setExpanded((old) => (old === name ? null : name))
                }
                aria-expanded={isExpanded}
                aria-label={"选择 " + name + " 版本"}
              >
                <strong>{name}</strong>
                <span
                  className={
                    "ce-operation-version-value" +
                    (!selected ? " is-unavailable" : "")
                  }
                >
                  {selected ? (
                    <>
                      <VersionIcon name={name} />
                      <span>{selected}</span>
                    </>
                  ) : !isExpanded || incompatible ? (
                    subtitle
                  ) : (
                    ""
                  )}
                </span>
                {!selected && !incompatible && !unsupported && (
                  <ChevronDown
                    size={17}
                    className={
                      "ce-disclosure-arrow" + (isExpanded ? " is-open" : "")
                    }
                  />
                )}
              </button>
              {selected && (
                <button
                  className="ce-operation-loader-remove"
                  aria-label={"从重置方案移除 " + name}
                  title="从重置方案移除，实例不会改变"
                  onClick={() => {
                    setChoices((old) => {
                      const next = { ...old };
                      delete next[name];
                      return next;
                    });
                    setExpanded(null);
                  }}
                >
                  <X size={17} />
                </button>
              )}
            </div>
            <Collapse open={isExpanded && !incompatible}>
              <div className="ce-modify-candidates">
                {changed && (
                  <button
                    className="ce-button ce-modify-cancel"
                    onClick={restoreChoices}
                  >
                    <X size={13} />
                    取消选择
                  </button>
                )}
                {isLoading ? (
                  <p className="ce-modify-candidate-state" role="status">
                    <LoaderCircle size={16} className="spin" />
                    正在获取兼容版本…
                  </p>
                ) : errors[name] ? (
                  <div className="ce-modify-candidate-state" role="status">
                    <p>{errors[name]}</p>
                    <button
                      className="ce-button"
                      onClick={() => setRefresh((old) => old + 1)}
                    >
                      重新获取
                    </button>
                  </div>
                ) : !versions.length ? (
                  <p className="ce-modify-candidate-state">
                    没有适用于 Minecraft {instance.minecraft_version} 的版本
                  </p>
                ) : (
                  <>
                    {versionRow(versions[0], true)}
                    <div className="ce-modify-all-versions">
                      全部版本 ({versions.length})
                    </div>
                    {versions.map((version) => (
                      <div key={version}>{versionRow(version)}</div>
                    ))}
                  </>
                )}
              </div>
            </Collapse>
          </section>
        );
      })}
      {changed && (
        <div className="ce-modify-draft-notice" role="status">
          <span>选择仅保存在本页，实例尚未修改。</span>
          <button className="ce-button" onClick={restoreChoices}>
            <X size={13} />
            取消选择
          </button>
        </div>
      )}
      <div className="ce-operation-floating-action">
        <button disabled title="实例重置尚未开放">
          <RotateCcw size={17} />
          开始重置
        </button>
      </div>
    </div>
  );
}

function ExportInstance({ instance, api }: { instance: Instance; api: Api }) {
  const [name, setName] = useState(instance.id);
  const [version, setVersion] = useState("");
  const [checks, setChecks] = useState(initialChecks);
  const [resources, setResources] = useState<Resources>(emptyResources);
  const [excluded, setExcluded] = useState<string[]>([]);
  const [advanced, setAdvanced] = useState(true);

  useEffect(() => {
    let live = true;
    setName(instance.id);
    setVersion("");
    setChecks(initialChecks);
    setExcluded([]);
    setResources(emptyResources());
    for (const kind of resourceKinds) {
      api<ResourceFile[]>("instance_resources", { id: instance.id, kind })
        .then((files) => {
          if (live)
            setResources((old) => ({
              ...old,
              [kind]: { files, loading: false, error: "" },
            }));
        })
        .catch((error) => {
          if (live)
            setResources((old) => ({
              ...old,
              [kind]: { files: [], loading: false, error: String(error) },
            }));
        });
    }
    return () => {
      live = false;
    };
  }, [instance.id, api]);

  function toggle(key: string) {
    setChecks((old) => ({ ...old, [key]: !old[key] }));
  }
  function option(
    key: string,
    label: string,
    description = "",
    child = false,
    disabled = false,
  ) {
    return (
      <label
        className={
          "ce-export-tree-row" +
          (child ? " is-child" : "") +
          (disabled ? " is-unavailable" : "")
        }
        title={disabled && key !== "game" ? unavailable : undefined}
      >
        <input
          type="checkbox"
          checked={checks[key]}
          disabled={disabled}
          onChange={() => toggle(key)}
        />
        <span>{label}</span>
        {description && <small>{description}</small>}
      </label>
    );
  }
  function fileList(kind: ResourceKind) {
    const group = resources[kind];
    if (group.loading)
      return (
        <div className="ce-export-tree-note is-child" role="status">
          正在读取文件…
        </div>
      );
    if (group.error)
      return (
        <div className="ce-export-tree-note is-child" role="alert">
          读取失败：{group.error}
        </div>
      );
    if (!group.files.length)
      return <div className="ce-export-tree-note is-child">没有本地文件</div>;
    return group.files.map((file) => (
      <label className="ce-export-tree-row is-child" key={kind + file.path}>
        <input
          type="checkbox"
          checked={!excluded.includes(kind + file.path)}
          onChange={() =>
            setExcluded((old) =>
              old.includes(kind + file.path)
                ? old.filter((path) => path !== kind + file.path)
                : [...old, kind + file.path],
            )
          }
        />
        <span>{file.file_name || file.name}</span>
      </label>
    ));
  }
  return (
    <div className="ce-instance-operation ce-instance-export">
      <section className="ce-card ce-export-name-card">
        <label htmlFor="ce-export-name">整合包名称</label>
        <input
          id="ce-export-name"
          className="ce-field"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="输入整合包名称"
        />
        <label htmlFor="ce-export-version">整合包版本</label>
        <input
          id="ce-export-version"
          className="ce-field"
          value={version}
          onChange={(event) => setVersion(event.target.value)}
          placeholder="1.0.0"
        />
      </section>
      <section className="ce-card ce-export-content-card">
        <h2 className="ce-card-title">导出内容列表</h2>
        <div className="ce-export-tree">
          {option(
            "game",
            "游戏本体",
            `Minecraft ${instance.minecraft_version}${instance.loader !== "Vanilla" ? `, ${instance.loader}` : ""}`,
            false,
            true,
          )}
          {option(
            "gameSettings",
            "游戏本体设置",
            "键位、音量、视频设置等",
            true,
          )}
          {option(
            "gamePersonal",
            "游戏本体个人信息",
            "命令历史、已保存的快捷栏",
            true,
          )}
          {option(
            "mods",
            "模组",
            resources.mods.loading
              ? "正在读取模组…"
              : resources.mods.error
                ? "模组列表读取失败"
                : `${resources.mods.files.length} 个模组`,
          )}
          <Collapse open={checks.mods}>
            {option(
              "packData",
              "整合包重要数据",
              "脚本文件、内置资源包、数据包等",
              true,
            )}
            {option("modSettings", "模组设置", "", true)}
            {option(
              "maps",
              "已绘制的地图",
              "地图类模组现有的存档、服务器记录的地图、路标点等",
              true,
            )}
            {option("jeiPersonal", "JEI 个人信息", "物品收藏夹等", true)}
            {option(
              "guidePersonal",
              "帕秋莉手册个人信息",
              "教程书的已读记录、书签、阅读历史记录等",
              true,
            )}
          </Collapse>
          {option("resourcepacks", "资源包", "纹理包/材质包")}
          <Collapse open={checks.resourcepacks}>
            {fileList("resourcepacks")}
          </Collapse>
          {option("shaderpacks", "光影包")}
          <Collapse open={checks.shaderpacks}>
            {fileList("shaderpacks")}
          </Collapse>
          {option("screenshots", "截图")}
          <Collapse open={checks.screenshots}>
            {fileList("screenshots")}
          </Collapse>
          {option("saves", "单人游戏存档", "世界/地图")}
          <Collapse open={checks.saves}>{fileList("saves")}</Collapse>
          {option("server", "多人游戏服务器列表", "", false, true)}
          {option("other", "其他文件夹", "未被上方选项覆盖的文件夹")}
          {option(
            "launcher",
            "PCL Linux 启动器程序",
            "打包启动器，以便没有启动器的玩家安装整合包",
            false,
            true,
          )}
        </div>
      </section>
      <section className="ce-card ce-export-advanced-card">
        <button
          className="ce-export-advanced-heading"
          onClick={() => setAdvanced((old) => !old)}
          aria-expanded={advanced}
        >
          <h2 className="ce-card-title">高级选项</h2>
          <ChevronDown
            size={17}
            className={"ce-disclosure-arrow" + (advanced ? " is-open" : "")}
          />
        </button>
        <Collapse open={advanced}>
          <div className="ce-export-tree">
            {option("bundleAssets", "打包资源文件，以避免在导入时下载")}
            {option("modrinth", "Modrinth 上传模式")}
          </div>
          <div className="ce-actions ce-export-config-actions">
            <button
              className="ce-button primary"
              disabled
              title="读取导出配置尚未开放"
            >
              读取配置
            </button>
            <button className="ce-button" disabled title="保存导出配置尚未开放">
              保存配置
            </button>
          </div>
        </Collapse>
      </section>
      <div className="ce-operation-floating-action">
        <button disabled title="实例导出尚未开放">
          <Box size={17} />
          开始导出
        </button>
      </div>
    </div>
  );
}

export function InstanceOperations({
  instance,
  section,
  api,
}: {
  instance: Instance;
  section: "modify" | "export";
  api: Api;
}) {
  return section === "modify" ? (
    <ModifyInstance instance={instance} api={api} />
  ) : (
    <ExportInstance instance={instance} api={api} />
  );
}
