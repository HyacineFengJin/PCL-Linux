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
  onBack,
  onStart,
}: {
  api: Api;
  rootId: string | null;
  version: string;
  native: boolean;
  disabled: boolean;
  onBack: () => void;
  onStart: () => void;
}) {
  const [name, setName] = useState(version);
  const [open, setOpen] = useState<string[]>([]);
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [catalogs, setCatalogs] = useState<Record<string, string[]>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState<string[]>([]);
  useEffect(() => {
    let disposed = false;
    setName(version);
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
  const hasComponents = Object.keys(choices).length > 0;
  const canInstall = native && !disabled && !hasComponents && name === version;
  const unavailable = !native
    ? "界面预览不能下载文件"
    : hasComponents
      ? "组件安装尚未开放"
      : name !== version
        ? "自定义实例名称尚未开放"
        : disabled
          ? "请等待当前任务结束"
          : "";
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
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </section>
      {providers.map((provider) => {
        const values = catalogs[provider] || [];
        const incompatible = conflict(provider);
        const expanded = open.includes(provider);
        const subtitle =
          choices[provider] ||
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
                {choices[provider] && (
                  <button
                    className="ce-button"
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
                      disabled={incompatible}
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
                        disabled={incompatible}
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
          onClick={onStart}
        >
          <Download size={19} />
          开始下载
        </button>
        {(hasComponents || name !== version) && (
          <small role="status">{unavailable}</small>
        )}
      </div>
    </div>
  );
}
