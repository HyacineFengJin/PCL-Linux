import { useEffect, useState } from "react";
import { ArrowRight, ChevronDown, PlusCircle } from "lucide-react";
import "./settings-panel.css";
import { Collapse } from "./Collapse";

type Settings = {
  root: string;
  player: string;
  memory_gib: number;
  selected: string | null;
  overrides: Record<string, number>;
};
type Java = { path: string; major: number; vendor: string; arch: string };
type SystemInfo = {
  total_memory_bytes: number;
  available_memory_bytes: number;
};
type Props = {
  section: string;
  settings: Settings;
  onSave: (settings: Settings) => Promise<void>;
  api: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
  native: boolean;
  disabled: boolean;
  onInstances: () => void;
  onNotify: (message: string) => void;
};
const unavailable = "此选项尚未开放，当前不会应用到游戏启动";
const jvm =
  "-XX:+UseG1GC -XX:-UseAdaptiveSizePolicy -XX:-OmitStackTraceInFastThrow -Djdk.lang.Process.allowAmbiguousCommands=true -Dfml.ignoreInvalidMinecraftCertificates=True -Dfml.ignorePatchDiscrepancies=True -Dlog4j2.formatMsgNoLookups=true";
function Field({
  label,
  value,
  multiline = false,
}: {
  label: string;
  value: string;
  multiline?: boolean;
}) {
  return (
    <label className="ce-settings-row">
      <span>{label}</span>
      {multiline ? (
        <textarea
          className="ce-field"
          value={value}
          readOnly
          disabled
          title={unavailable}
        />
      ) : (
        <div className="ce-settings-control">
          <input
            className="ce-field"
            value={value}
            readOnly
            disabled
            title={unavailable}
          />
          {[
            "默认实例隔离",
            "游戏窗口标题",
            "启动器可见性",
            "进程优先级",
            "窗口大小",
            "正版验证方式",
            "IP 协议偏好",
            "渲染器",
          ].includes(label) && <ChevronDown size={17} />}
        </div>
      )}
    </label>
  );
}
export function SettingsPanel({
  section,
  settings,
  onSave,
  api,
  native,
  disabled,
  onInstances,
  onNotify,
}: Props) {
  const [memory, setMemory] = useState(settings.memory_gib);
  const [advanced, setAdvanced] = useState(false);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [javas, setJavas] = useState<Java[]>([]);
  const [javaError, setJavaError] = useState("");
  const [javaLoading, setJavaLoading] = useState(false);
  useEffect(() => {
    setMemory(settings.memory_gib);
  }, [settings.memory_gib]);
  useEffect(() => {
    let current = true;
    api<SystemInfo>("system_info")
      .then((v) => {
        if (current) setSystem(v);
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [api, native]);
  useEffect(() => {
    if (section !== "java") return;
    let current = true;
    setJavaError("");
    setJavaLoading(true);
    api<Java[]>("java_list", { root: settings.root })
      .then((v) => {
        if (current) setJavas(v);
      })
      .catch(() => {
        if (current) setJavaError("暂时无法获取本机 Java 列表");
      })
      .finally(() => {
        if (current) setJavaLoading(false);
      });
    return () => {
      current = false;
    };
  }, [section, settings.root, api]);
  const saveMemory = async () => {
    if (memory === settings.memory_gib || disabled) return;
    try {
      await onSave({ ...settings, memory_gib: memory });
    } catch (e) {
      onNotify(String(e));
    }
  };
  if (section === "java")
    return (
      <div className="ce-settings-panel">
        <div className="ce-card ce-java-add">
          <button disabled title="手动添加 Java 尚未开放">
            <PlusCircle size={20} />
            添加
          </button>
        </div>
        <section className="ce-card ce-java-list">
          <div className="ce-java-auto">
            <strong>自动选择</strong>
            <p>Java 选择自动档，依据游戏需要自动选择合适的 Java</p>
          </div>
          {javas.map((java) => (
            <div className="ce-java-entry" key={java.path}>
              <div>JDK {java.major}</div>
              <p>
                <span>{java.arch}</span> <span>{java.vendor}</span> {java.path}
              </p>
            </div>
          ))}
          {javaError && <p className="ce-java-status">{javaError}</p>}
          {!javaError && javas.length === 0 && (
            <p className="ce-java-status">
              {javaLoading ? "正在扫描本机 Java…" : "未找到可用的 Java"}
            </p>
          )}
        </section>
      </div>
    );
  if (!["launch", "启动", "game"].includes(section))
    return (
      <section className="ce-card">
        <h2 className="ce-card-title">此设置页面尚未开放</h2>
      </section>
    );
  const gib = (bytes: number) => (bytes / 1073741824).toFixed(1);
  const used = system
    ? system.total_memory_bytes - system.available_memory_bytes
    : 0;
  return (
    <div className="ce-settings-panel">
      <section className="ce-card">
        <h2 className="ce-card-title">启动选项</h2>
        <div className="ce-settings-fields">
          <Field label="默认实例隔离" value="隔离所有实例" />
          <Field label="游戏窗口标题" value="默认" />
          <Field label="自定义信息" value="PCL CE" />
          <Field
            label="启动器可见性"
            value="游戏启动后隐藏，游戏退出后重新打开"
          />
          <Field label="进程优先级" value="中（平衡）" />
          <Field label="窗口大小" value="默认" />
          <Field label="正版验证方式" value="设备代码流" />
          <Field label="IP 协议偏好" value="Java 默认" />
        </div>
      </section>
      <section className="ce-card ce-memory-card">
        <h2 className="ce-card-title">游戏内存</h2>
        {system && memory * 1073741824 > system.available_memory_bytes && (
          <div className="ce-memory-warning">
            你给游戏分配的内存过多，这可能引发游戏崩溃。建议优先考虑「自动分配」选项！
          </div>
        )}
        <label className="ce-memory-mode" title={unavailable}>
          <input type="radio" disabled checked={false} readOnly />
          自动配置
        </label>
        <div className="ce-memory-custom">
          <label className="ce-memory-mode">
            <input type="radio" checked readOnly />
            自定义
          </label>
          <input
            aria-label="游戏内存 GiB"
            type="range"
            min="2"
            max={Math.max(14, settings.memory_gib)}
            step="1"
            value={memory}
            disabled={disabled}
            onChange={(e) => setMemory(Number(e.target.value))}
            onPointerUp={() => void saveMemory()}
            onKeyUp={() => void saveMemory()}
            onBlur={() => void saveMemory()}
          />
        </div>
        <div className="ce-memory-labels">
          <span>已使用内存 / 已安装内存</span>
          <span>游戏分配</span>
        </div>
        <div className="ce-memory-bar">
          <span
            style={{
              width: system
                ? `${Math.min(100, (used / system.total_memory_bytes) * 100)}%`
                : "0%",
            }}
          />
        </div>
        <div className="ce-memory-values">
          <span>
            {system
              ? `${gib(used)} GiB / ${gib(system.total_memory_bytes)} GiB`
              : "内存信息暂不可用"}
          </span>
          <span>
            {memory.toFixed(1)} GiB
            {system ? ` (可用 ${gib(system.available_memory_bytes)} GiB)` : ""}
          </span>
        </div>
      </section>
      <section className="ce-card ce-advanced-card">
        <button
          className="ce-advanced-heading"
          onClick={() => setAdvanced(!advanced)}
          aria-expanded={advanced}
        >
          <h2 className="ce-card-title">高级启动选项</h2>
          <ChevronDown
            className={`ce-disclosure-arrow ${advanced ? "is-open" : ""}`}
            size={20}
          />
        </button>
        <Collapse open={advanced}>
          <div className="ce-advanced-content">
            <Field label="渲染器" value="游戏默认" />
            <Field label="JVM 参数头部" value={jvm} multiline />
            <Field label="游戏参数尾部" value="" />
            <Field label="启动前执行命令" value="" />
            <div className="ce-advanced-checks">
              {[
                "禁用 Java Launch Wrapper",
                "禁用 LegacyFix",
                "要求 Java 使用高性能显卡",
                "使用 java.exe 而不是 javaw.exe",
                "禁用 LWJGL Unsafe Agent",
                "禁用自动崩溃分析",
                "锁定内存分配（-Xms = -Xmx）",
              ].map((label, i) => (
                <label key={label} title={unavailable}>
                  <input
                    type="checkbox"
                    checked={i === 0 || i === 2}
                    disabled
                    readOnly
                  />
                  {label}
                </label>
              ))}
            </div>
          </div>
        </Collapse>
      </section>
      <Collapse open={advanced}>
        <div className="ce-settings-footer">
          <button className="ce-button" onClick={onInstances}>
            <ArrowRight size={20} />
            实例独立设置
          </button>
        </div>
      </Collapse>
    </div>
  );
}
