import { useEffect, useRef, useState, type ReactNode } from "react";
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
type ComponentSelection = { provider: string; version: string };
type ResetPlan = {
  revision: string;
  id: string;
  minecraft: string;
  components: ComponentSelection[];
  current_components: ComponentSelection[];
  current_summary: string;
};
type ExportRequest = {
  name: string;
  version: string;
  checks: Record<string, boolean>;
  excluded: Record<string, string[]>;
};
type ExportPlan = {
  revision: string;
  bytes: number;
  file_count: number;
  request: ExportRequest;
  instance_id: string;
  warnings: string[];
};
type OperationProps = {
  instance: Instance;
  api: Api;
  scopeKey: string;
  native: boolean;
  busy: boolean;
  onTaskStart: (id: string) => void;
  onNotify: (message: string) => void;
};

function useOperationScope({
  instance,
  api,
  scopeKey,
  native,
  busy,
}: OperationProps) {
  const scope = useRef({
    api,
    id: instance.id,
    root: scopeKey,
    loader: instance.loader,
    minecraft: instance.minecraft_version,
  });
  if (
    scope.current.api !== api ||
    scope.current.id !== instance.id ||
    scope.current.root !== scopeKey ||
    scope.current.loader !== instance.loader ||
    scope.current.minecraft !== instance.minecraft_version
  ) {
    scope.current = {
      api,
      id: instance.id,
      root: scopeKey,
      loader: instance.loader,
      minecraft: instance.minecraft_version,
    };
  }
  const captured = scope.current;
  const live = useRef(true);
  const availability = useRef({ native, busy });
  availability.current = { native, busy };
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const current = () => live.current && scope.current === captured;
  return {
    current,
    allowed: () =>
      current() && availability.current.native && !availability.current.busy,
  };
}

function OperationConfirmation({
  title,
  children,
  working,
  disabled,
  confirm,
  onClose,
  onConfirm,
}: {
  title: string;
  children: ReactNode;
  working: boolean;
  disabled: boolean;
  confirm: string;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      className="modal-shade rd-name-shade"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !working) onClose();
      }}
    >
      <form
        className="rd-name-dialog ce-operation-confirmation"
        role="dialog"
        aria-modal="true"
        aria-busy={working}
        aria-labelledby="ce-operation-confirm-title"
        onSubmit={(event) => {
          event.preventDefault();
          if (!working && !disabled) onConfirm();
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            if (!working) onClose();
          }
          if (event.key === "Tab") {
            const controls = [
              ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
                "button:not(:disabled)",
              ),
            ];
            const first = controls[0],
              last = controls[controls.length - 1];
            if (!first) event.preventDefault();
            else if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first.focus();
            }
          }
        }}
      >
        <h2 id="ce-operation-confirm-title">{title}</h2>
        {children}
        <div className="rd-name-actions">
          <button
            type="button"
            className="ce-button"
            autoFocus
            disabled={working}
            onClick={onClose}
          >
            取消
          </button>
          <button className="ce-button primary" disabled={working || disabled}>
            {working ? "正在提交…" : confirm}
          </button>
        </div>
      </form>
    </div>
  );
}

function componentSummary(components: ComponentSelection[]) {
  const names: Record<string, string> = {
    forge: "Forge",
    neoforge: "NeoForge",
    fabric: "Fabric",
  };
  return components.length
    ? components
        .map(
          (item) =>
            `${names[item.provider.toLowerCase()] || item.provider} ${item.version}`,
        )
        .join("、")
    : "原版";
}
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
const candidateProviders = ["Forge", "NeoForge", "Fabric"];

function instanceChoices(instance: Instance): Record<string, string> {
  const [name, ...version] = instance.loader.split(" ");
  return name === "Vanilla" ? {} : { [name]: version.join(" ") || "已安装" };
}

function ModifyInstance(props: OperationProps) {
  const { instance, api, native, busy, onTaskStart, onNotify } = props;
  const scope = useOperationScope(props);
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
  const [activity, setActivity] = useState<"plan" | "start" | "recover" | null>(
    null,
  );
  const [error, setError] = useState("");
  const [plan, setPlan] = useState<ResetPlan | null>(null);
  const working = useRef(false);
  const locked = !!activity || !!plan || busy;
  const supportedCurrent =
    loaderName === "Vanilla" || candidateProviders.includes(loaderName);

  async function prepareReset() {
    if (!scope.allowed() || working.current || !supportedCurrent) return;
    working.current = true;
    setActivity("plan");
    setError("");
    try {
      const next = await api<ResetPlan>("instance_reset_plan", {
        id: instance.id,
        components: Object.entries(choices).map(([provider, version]) => ({
          provider: provider.toLowerCase(),
          version,
        })),
      });
      if (scope.current()) setPlan(next);
    } catch (failure) {
      if (scope.current()) setError(String(failure));
    } finally {
      if (scope.current()) {
        working.current = false;
        setActivity(null);
      }
    }
  }
  async function startReset() {
    if (!plan || !scope.allowed() || working.current) return;
    working.current = true;
    setActivity("start");
    setError("");
    try {
      const id = await api<string>("instance_reset_start", { plan });
      if (scope.current()) {
        setPlan(null);
        onTaskStart(id);
      }
    } catch (failure) {
      if (scope.current()) {
        setPlan(null);
        setError(String(failure));
        onNotify(String(failure));
      }
    } finally {
      if (scope.current()) {
        working.current = false;
        setActivity(null);
      }
    }
  }
  async function recoverReset() {
    if (
      !scope.allowed() ||
      working.current ||
      !error.includes("存在未完成的实例重置")
    )
      return;
    working.current = true;
    setActivity("recover");
    let recovered = false;
    try {
      await api("instance_reset_recover");
      if (scope.current()) {
        setError("");
        onNotify("实例重置恢复完成");
        recovered = true;
      }
    } catch (failure) {
      if (scope.current()) setError(String(failure));
    } finally {
      if (scope.current()) {
        working.current = false;
        setActivity(null);
      }
    }
    if (recovered && scope.allowed()) await prepareReset();
  }

  useEffect(() => {
    setChoices(instanceChoices(instance));
    setExpanded(null);
    setPlan(null);
    setError("");
    setActivity(null);
    working.current = false;
  }, [
    instance.id,
    instance.loader,
    instance.minecraft_version,
    api,
    props.scopeKey,
  ]);

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
    if (locked || conflict(name) || !candidateProviders.includes(name)) return;
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
        const unsupported = !candidateProviders.includes(name);
        const subtitle =
          selected ||
          (incompatible
            ? `与 ${incompatible} 不兼容`
            : unsupported
              ? "暂不支持重置此组件"
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
              disabled={locked || !!incompatible}
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
                disabled={locked || !!incompatible || unsupported}
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
                  disabled={locked || unsupported}
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
                    disabled={locked}
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
                      disabled={locked}
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
          <button
            className="ce-button"
            disabled={locked}
            onClick={restoreChoices}
          >
            <X size={13} />
            取消选择
          </button>
        </div>
      )}
      {error && (
        <p className="ce-operation-error" role="alert">
          {error}
        </p>
      )}
      {error.includes("存在未完成的实例重置") && (
        <div className="ce-operation-recovery">
          <button
            className="ce-button"
            disabled={!native || locked}
            onClick={() => void recoverReset()}
          >
            {activity === "recover" ? "正在恢复…" : "恢复未完成重置"}
          </button>
        </div>
      )}
      {!supportedCurrent && (
        <p className="ce-operation-note">此实例的组件暂不支持重置。</p>
      )}
      <div className="ce-operation-floating-action">
        <button
          disabled={!native || locked || !supportedCurrent}
          title={
            !native
              ? "请在桌面应用中重置实例"
              : busy
                ? "当前有游戏或任务运行"
                : undefined
          }
          onClick={() => void prepareReset()}
        >
          {activity === "plan" ? (
            <LoaderCircle size={17} className="spin" />
          ) : (
            <RotateCcw size={17} />
          )}
          {activity === "plan" ? "正在检查…" : "开始重置"}
        </button>
      </div>
      {plan && (
        <OperationConfirmation
          title="重置游戏实例"
          working={activity === "start"}
          disabled={!native || busy}
          confirm="开始重置"
          onClose={() => setPlan(null)}
          onConfirm={() => void startReset()}
        >
          <dl>
            <dt>游戏实例</dt>
            <dd>{plan.id}</dd>
            <dt>Minecraft</dt>
            <dd>{plan.minecraft}（版本不变）</dd>
            <dt>当前组件</dt>
            <dd>
              {plan.current_summary ||
                componentSummary(plan.current_components)}
            </dd>
            <dt>重置后组件</dt>
            <dd>{componentSummary(plan.components)}</dd>
          </dl>
          <p>
            将替换此实例的版本 JSON 和
            JAR。模组、配置、存档、选项和实例个性化信息会保留。
          </p>
        </OperationConfirmation>
      )}
    </div>
  );
}

function ExportInstance(props: OperationProps) {
  const { instance, api, native, busy, onTaskStart, onNotify } = props;
  const scope = useOperationScope(props);
  const [name, setName] = useState(instance.id);
  const [version, setVersion] = useState("1.0.0");
  const [checks, setChecks] = useState(initialChecks);
  const [resources, setResources] = useState<Resources>(emptyResources);
  const [excluded, setExcluded] = useState<Record<string, string[]>>({});
  const [advanced, setAdvanced] = useState(true);
  const [activity, setActivity] = useState<
    "plan" | "start" | "read" | "save" | "recover" | null
  >(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [plan, setPlan] = useState<ExportPlan | null>(null);
  const working = useRef(false);
  const locked = !!activity || !!plan || busy;
  const invalid = !name.trim()
    ? "请输入整合包名称"
    : Array.from(name.trim()).length > 200
      ? "整合包名称不能超过 200 个字符"
      : !version.trim()
        ? "请输入整合包版本"
        : Array.from(version.trim()).length > 128
          ? "整合包版本不能超过 128 个字符"
          : /[\u0000-\u001f\u007f]/.test(name + version)
            ? "名称和版本不能包含控制字符"
            : "";
  const request = (): ExportRequest => ({
    name: name.trim(),
    version: version.trim(),
    checks: { ...checks, game: true, launcher: false, modrinth: false },
    excluded,
  });

  async function prepareExport() {
    if (!scope.allowed() || working.current || invalid) return;
    working.current = true;
    setActivity("plan");
    setError("");
    setMessage("");
    try {
      const next = await api<ExportPlan>("instance_export_plan", {
        id: instance.id,
        request: request(),
      });
      if (scope.current()) setPlan(next);
    } catch (failure) {
      if (scope.current()) setError(String(failure));
    } finally {
      if (scope.current()) {
        working.current = false;
        setActivity(null);
      }
    }
  }
  async function startExport() {
    if (!plan || !scope.allowed() || working.current) return;
    working.current = true;
    setActivity("start");
    setError("");
    try {
      const id = await api<string | null>("instance_export_start", { plan });
      if (scope.current()) {
        setPlan(null);
        if (id) onTaskStart(id);
        else setMessage("已取消选择导出位置。");
      }
    } catch (failure) {
      if (scope.current()) {
        setPlan(null);
        setError(String(failure));
        onNotify(String(failure));
      }
    } finally {
      if (scope.current()) {
        working.current = false;
        setActivity(null);
      }
    }
  }
  async function readConfig() {
    if (!scope.allowed() || working.current) return;
    working.current = true;
    setActivity("read");
    setError("");
    setMessage("");
    try {
      const saved = await api<ExportRequest | null>(
        "instance_export_config_read",
        { id: instance.id },
      );
      if (!scope.current()) return;
      if (!saved) {
        setMessage("此实例还没有保存导出配置。");
        return;
      }
      setName(saved.name);
      setVersion(saved.version);
      setChecks(
        Object.fromEntries(
          Object.keys(initialChecks).map((key) => [
            key,
            key === "game"
              ? true
              : ["launcher", "modrinth"].includes(key)
                ? false
                : (saved.checks[key] ?? initialChecks[key]),
          ]),
        ),
      );
      setExcluded(saved.excluded);
      setMessage("已读取此实例的导出配置。");
    } catch (failure) {
      if (scope.current()) setError(String(failure));
    } finally {
      if (scope.current()) {
        working.current = false;
        setActivity(null);
      }
    }
  }
  async function saveConfig() {
    if (!scope.allowed() || working.current || invalid) return;
    working.current = true;
    setActivity("save");
    setError("");
    setMessage("");
    try {
      await api<void>("instance_export_config_save", {
        id: instance.id,
        request: request(),
      });
      if (scope.current()) {
        setMessage("已保存此实例的导出配置。");
        onNotify("已保存导出配置");
      }
    } catch (failure) {
      if (scope.current()) setError(String(failure));
    } finally {
      if (scope.current()) {
        working.current = false;
        setActivity(null);
      }
    }
  }
  async function recoverReset() {
    if (
      !scope.allowed() ||
      working.current ||
      !error.includes("存在未完成的实例重置")
    )
      return;
    working.current = true;
    setActivity("recover");
    let recovered = false;
    try {
      await api("instance_reset_recover");
      if (scope.current()) {
        setError("");
        onNotify("实例重置恢复完成");
        recovered = true;
      }
    } catch (failure) {
      if (scope.current()) setError(String(failure));
    } finally {
      if (scope.current()) {
        working.current = false;
        setActivity(null);
      }
    }
    if (recovered && scope.allowed()) await prepareExport();
  }

  useEffect(() => {
    let live = true;
    setName(instance.id);
    setVersion("1.0.0");
    setChecks(initialChecks);
    setExcluded({});
    setPlan(null);
    setError("");
    setMessage("");
    setActivity(null);
    working.current = false;
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
  }, [instance.id, api, props.scopeKey]);

  function toggle(key: string) {
    if (!locked) setChecks((old) => ({ ...old, [key]: !old[key] }));
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
          checked={checks[key] ?? false}
          disabled={disabled || locked}
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
    return group.files.map((file) => {
      const filename = file.file_name || file.name;
      const omitted = excluded[kind] || [];
      return (
        <label className="ce-export-tree-row is-child" key={kind + filename}>
          <input
            type="checkbox"
            checked={!omitted.includes(filename)}
            disabled={locked}
            onChange={() =>
              setExcluded((old) => ({
                ...old,
                [kind]: (old[kind] || []).includes(filename)
                  ? (old[kind] || []).filter((value) => value !== filename)
                  : [...(old[kind] || []), filename],
              }))
            }
          />
          <span>{file.file_name || file.name}</span>
        </label>
      );
    });
  }
  return (
    <div className="ce-instance-operation ce-instance-export">
      <section className="ce-card ce-export-name-card">
        <label htmlFor="ce-export-name">整合包名称</label>
        <input
          id="ce-export-name"
          className="ce-field"
          value={name}
          disabled={locked}
          onChange={(event) => setName(event.target.value)}
          placeholder="输入整合包名称"
        />
        <label htmlFor="ce-export-version">整合包版本</label>
        <input
          id="ce-export-version"
          className="ce-field"
          value={version}
          disabled={locked}
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
          {option("server", "多人游戏服务器列表")}
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
            {option("modrinth", "Modrinth 上传模式", "", false, true)}
          </div>
          <p className="ce-operation-note">
            导出为本地
            ZIP。个人信息和模组数据按已识别的文件位置筛选，自定义模组文件请在导出前核对。
          </p>
          <div className="ce-actions ce-export-config-actions">
            <button
              className="ce-button primary"
              disabled={!native || locked}
              title="读取此实例上次保存的导出配置"
              onClick={() => void readConfig()}
            >
              {activity === "read" ? "正在读取…" : "读取配置"}
            </button>
            <button
              className="ce-button"
              disabled={!native || locked || !!invalid}
              title="将当前选项保存为此实例的导出配置"
              onClick={() => void saveConfig()}
            >
              {activity === "save" ? "正在保存…" : "保存配置"}
            </button>
          </div>
        </Collapse>
      </section>
      {(error || invalid) && (
        <p className="ce-operation-error" role="alert">
          {error || invalid}
        </p>
      )}
      {error.includes("存在未完成的实例重置") && (
        <div className="ce-operation-recovery">
          <button
            className="ce-button"
            disabled={!native || locked}
            onClick={() => void recoverReset()}
          >
            {activity === "recover" ? "正在恢复…" : "恢复未完成重置"}
          </button>
        </div>
      )}
      {message && (
        <p className="ce-operation-note" role="status">
          {message}
        </p>
      )}
      <div className="ce-operation-floating-action">
        <button
          disabled={!native || locked || !!invalid}
          title={
            !native
              ? "请在桌面应用中导出实例"
              : busy
                ? "当前有游戏或任务运行"
                : invalid || undefined
          }
          onClick={() => void prepareExport()}
        >
          {activity === "plan" ? (
            <LoaderCircle size={17} className="spin" />
          ) : (
            <Box size={17} />
          )}
          {activity === "plan" ? "正在检查…" : "开始导出"}
        </button>
      </div>
      {plan && (
        <OperationConfirmation
          title="导出游戏实例"
          working={activity === "start"}
          disabled={!native || busy}
          confirm="选择导出位置"
          onClose={() => setPlan(null)}
          onConfirm={() => void startExport()}
        >
          <dl>
            <dt>游戏实例</dt>
            <dd>{plan.instance_id}</dd>
            <dt>整合包</dt>
            <dd>
              {plan.request.name} {plan.request.version}
            </dd>
            <dt>导出格式</dt>
            <dd>本地 ZIP</dd>
            <dt>导出内容</dt>
            <dd>
              {plan.file_count} 个文件，{(plan.bytes / 1024 / 1024).toFixed(1)}{" "}
              MiB
            </dd>
          </dl>
          {(plan.warnings || []).map((warning) => (
            <p className="ce-operation-note" key={warning}>
              {warning}
            </p>
          ))}
        </OperationConfirmation>
      )}
    </div>
  );
}

export function InstanceOperations({
  instance,
  section,
  api,
  ...props
}: OperationProps & {
  section: "modify" | "export";
}) {
  return section === "modify" ? (
    <ModifyInstance
      key={`${props.scopeKey}:${instance.id}`}
      instance={instance}
      api={api}
      {...props}
    />
  ) : (
    <ExportInstance
      key={`${props.scopeKey}:${instance.id}`}
      instance={instance}
      api={api}
      {...props}
    />
  );
}
