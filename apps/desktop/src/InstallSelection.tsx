import { useEffect, useState } from "react";
import {
  ArrowLeft,
  Box,
  ChevronDown,
  Download,
  Gauge,
  LoaderCircle,
  ScrollText,
  X,
} from "lucide-react";
import type { Api } from "./types";
import { Collapse } from "./Collapse";
import { loaderCandidates } from "./loaderCandidates";
import grass from "./assets/game-icons/grass.png";
import forge from "./assets/game-icons/forge.png";
import neoForge from "./assets/game-icons/neoforge.png";
import "./install-selection.css";
const providers = ["Forge", "NeoForge", "Fabric", "LabyMod", "OptiFine"];
const unavailableProviders: Record<string, string> = {
  LabyMod: "LabyMod 安装暂未开放",
  OptiFine: "OptiFine 安装暂未开放",
};

export type InstallComponent = { provider: string; version: string };
export type InstallOptions = {
  name: string;
  components: InstallComponent[];
};

export function installNameError(name: string, installed: { id: string }[]) {
  if (!name.trim()) return "请输入实例名称";
  if (name !== name.trim()) return "实例名称不能以空白字符开头或结尾";
  if (name.startsWith(".install-")) return "实例名称不能使用 .install- 前缀";
  if (
    name === "." ||
    name === ".." ||
    /[/\\:]/.test(name) ||
    /\p{Cc}/u.test(name)
  )
    return "实例名称不能包含路径分隔符、冒号或控制字符";
  if (new TextEncoder().encode(name).length > 120)
    return "实例名称过长，请缩短到 120 字节以内";
  if (installed.some((instance) => instance.id === name))
    return "此游戏目录中已存在同名实例，请修改名称";
  return "";
}

function ComponentIcon({ name }: { name: string }) {
  if (name === "Forge" || name === "NeoForge")
    return <img src={name === "Forge" ? forge : neoForge} alt="" />;
  const Icon =
    name === "Fabric" ? ScrollText : name === "OptiFine" ? Gauge : Box;
  return <Icon size={29} strokeWidth={1.6} />;
}
export function InstallSelection({
  api,
  rootId,
  version,
  native,
  disabled,
  installed = [],
  onBack,
  onStart,
}: {
  api: Api;
  rootId: string | null;
  version: string;
  native: boolean;
  disabled: boolean;
  installed?: { id: string }[];
  onBack: () => void;
  onStart: (options: InstallOptions) => void;
}) {
  const [name, setName] = useState(version);
  const [nameEdited, setNameEdited] = useState(false);
  const [open, setOpen] = useState<string[]>([]);
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [catalogs, setCatalogs] = useState<Record<string, string[]>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState<string[]>([]);
  useEffect(() => {
    let disposed = false;
    setName(version);
    setNameEdited(false);
    setOpen([]);
    setChoices({});
    setCatalogs({});
    setErrors({});
    setLoading(providers);
    for (const provider of providers) {
      const request = loaderCandidates(api, provider, version);
      request
        .then((values) => {
          if (!disposed) setCatalogs((old) => ({ ...old, [provider]: values }));
        })
        .catch((e) => {
          if (!disposed)
            setErrors((old) => ({ ...old, [provider]: String(e) }));
        })
        .finally(() => {
          if (!disposed) setLoading((old) => old.filter((v) => v !== provider));
        });
    }
    return () => {
      disposed = true;
    };
  }, [api, version, rootId]);
  function conflict(provider: string) {
    const selected = Object.keys(choices);
    if (provider === "OptiFine")
      return selected.some((v) =>
        ["NeoForge", "Fabric", "LabyMod"].includes(v),
      );
    return (
      selected.some((v) => v !== provider && v !== "OptiFine") ||
      (provider !== "Forge" && !!choices.OptiFine)
    );
  }
  const components = providers.flatMap((provider) =>
    choices[provider] ? [{ provider, version: choices[provider] }] : [],
  );
  const automaticName = [
    version,
    ...components.map(
      (component) => `${component.provider}_${component.version}`,
    ),
  ].join("-");
  const instanceName = nameEdited ? name : automaticName;
  const nameError = installNameError(instanceName, installed);
  const componentError = components
    .map((component) => unavailableProviders[component.provider])
    .find(Boolean);
  const canInstall = native && !disabled && !nameError && !componentError;
  const unavailable = !native
    ? "界面预览不能下载文件"
    : nameError || componentError || (disabled ? "当前无法开始安装" : "");
  function submit() {
    if (canInstall) onStart({ name: instanceName, components });
  }
  return (
    <div className="ce-install-selection ce-page-enter">
      <section className="ce-card ce-install-name">
        <button
          className="icon-button"
          aria-label="返回版本列表"
          onClick={onBack}
        >
          <ArrowLeft size={19} />
        </button>
        <img src={grass} alt="" />
        <input
          className="ce-field"
          aria-label="实例名称"
          value={instanceName}
          maxLength={120}
          disabled={disabled}
          aria-invalid={!!nameError}
          aria-describedby={nameError ? "ce-install-name-error" : undefined}
          onChange={(e) => {
            setNameEdited(true);
            setName(e.target.value);
          }}
        />
      </section>
      {nameError && (
        <p
          className="ce-install-name-error"
          id="ce-install-name-error"
          role="status"
        >
          {nameError}
        </p>
      )}
      {providers.map((provider) => {
        const values = catalogs[provider] || [];
        const incompatible = conflict(provider);
        const unavailableProvider = unavailableProviders[provider];
        const expanded = open.includes(provider);
        const subtitle =
          choices[provider] ||
          unavailableProvider ||
          (incompatible
            ? "与所选组件不兼容"
            : loading.includes(provider)
              ? "正在获取…"
              : errors[provider]
                ? "暂不可用"
                : values.length
                  ? "可以添加"
                  : "没有可用版本");
        return (
          <section
            className={`ce-card ce-install-provider ${incompatible ? "incompatible" : ""}`}
            key={provider}
          >
            <button
              className="ce-install-toggle"
              onClick={() =>
                setOpen((old) =>
                  old.includes(provider)
                    ? old.filter((v) => v !== provider)
                    : [...old, provider],
                )
              }
              aria-expanded={expanded}
            >
              <strong>{provider}</strong>
              <span>{expanded && !choices[provider] ? "" : subtitle}</span>
              <ChevronDown
                size={18}
                className={`ce-disclosure-arrow ${expanded ? "is-open" : ""}`}
              />
            </button>
            <Collapse open={expanded}>
              <div className="ce-install-versions">
                {unavailableProvider && (
                  <p className="muted" role="status">
                    {unavailableProvider}
                  </p>
                )}
                {choices[provider] && (
                  <button
                    className="ce-button"
                    disabled={disabled}
                    onClick={() =>
                      setChoices((old) => {
                        const next = { ...old };
                        delete next[provider];
                        return next;
                      })
                    }
                  >
                    <X size={13} />
                    取消选择
                  </button>
                )}
                {loading.includes(provider) ? (
                  <p className="muted">
                    <LoaderCircle size={16} className="spin" />{" "}
                    正在获取兼容版本…
                  </p>
                ) : errors[provider] ? (
                  <p className="muted" role="status">
                    {errors[provider]}
                  </p>
                ) : !values.length ? (
                  <p className="muted">没有适用于 Minecraft {version} 的版本</p>
                ) : (
                  <>
                    <button
                      className={`ce-install-version ${choices[provider] === values[0] ? "selected" : ""}`}
                      disabled={
                        disabled || incompatible || !!unavailableProvider
                      }
                      onClick={() =>
                        setChoices((old) => ({ ...old, [provider]: values[0] }))
                      }
                    >
                      <ComponentIcon name={provider} />
                      <span>
                        <strong>{values[0]}</strong>
                        <small>最新版本</small>
                      </span>
                    </button>
                    <div className="ce-install-all">
                      全部版本 ({values.length})
                    </div>
                    {values.map((value) => (
                      <button
                        key={value}
                        className={`ce-install-version ${choices[provider] === value ? "selected" : ""}`}
                        disabled={
                          disabled || incompatible || !!unavailableProvider
                        }
                        onClick={() =>
                          setChoices((old) => ({ ...old, [provider]: value }))
                        }
                      >
                        <ComponentIcon name={provider} />
                        <span>
                          <strong>{value}</strong>
                        </span>
                      </button>
                    ))}
                  </>
                )}
              </div>
            </Collapse>
          </section>
        );
      })}
      <div className="ce-install-action">
        <button
          className="ce-pill-action"
          disabled={!canInstall}
          title={unavailable || undefined}
          onClick={submit}
        >
          <Download size={19} />
          开始下载
        </button>
        {unavailable && <small role="status">{unavailable}</small>}
      </div>
    </div>
  );
}
