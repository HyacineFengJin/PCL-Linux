import type { Api, Instance, JavaRuntime, Settings } from "./types";
import { useJavaAction, useJavaCatalog } from "./javaManagement";

function requiresExactJava(instance: Instance) {
  return /^(?:Forge|NeoForge)(?:\s|$)/.test(instance.loader);
}

export function javaCompatible(runtime: JavaRuntime, instance: Instance) {
  return requiresExactJava(instance)
    ? runtime.major === instance.java_major
    : runtime.major >= instance.java_major;
}

export function JavaSelect({
  instance,
  settings,
  api,
  native,
  disabled,
  onSave,
  onNotify,
}: {
  instance: Instance;
  settings: Settings;
  api: Api;
  native: boolean;
  disabled: boolean;
  onSave: (settings: Settings) => Promise<void>;
  onNotify: (message: string) => void;
}) {
  const { catalog, loading, error } = useJavaCatalog(api, settings);
  const action = useJavaAction({
    api,
    settings,
    context: JSON.stringify([
      instance.id,
      instance.loader,
      instance.java_major,
    ]),
    native,
    disabled,
    onNotify,
  });
  const override = settings.java_overrides?.[instance.id];
  const effective = override || settings.java || { mode: "auto" };
  const value = !override
    ? "follow"
    : override.mode === "auto"
      ? "auto"
      : `manual:${override.path}`;
  const unavailable = [...catalog.unavailable];
  if (
    override?.mode === "manual" &&
    !catalog.runtimes.some((runtime) => runtime.path === override.path) &&
    !unavailable.some((runtime) => runtime.path === override.path)
  )
    unavailable.unshift({ path: override.path, error: "未找到此 Java" });
  let selectionError = "";
  if (!loading && effective.mode === "manual") {
    const runtime = catalog.runtimes.find(
      (java) => java.path === effective.path,
    );
    if (!runtime)
      selectionError =
        catalog.unavailable.find((java) => java.path === effective.path)
          ?.error || "未找到所选 Java，请选择其他 Java";
    else if (!javaCompatible(runtime, instance))
      selectionError = `此实例需要 Java ${instance.java_major}${requiresExactJava(instance) ? "，所选 Java 版本必须相同" : " 或更新版本"}`;
    if (selectionError && !override)
      selectionError = `全局 Java：${selectionError}`;
  }
  return (
    <label className="ce-row">
      <span>游戏 Java</span>
      <div className="ce-java-select-control">
        <select
          className="ce-field"
          value={value}
          disabled={action.disabled}
          onChange={(event) => {
            const next = event.target.value;
            void action.run(async () => {
              const java_overrides = { ...settings.java_overrides };
              if (next === "follow") delete java_overrides[instance.id];
              else if (next === "auto")
                java_overrides[instance.id] = { mode: "auto" };
              else {
                const path = next.slice("manual:".length);
                const runtime = catalog.runtimes.find(
                  (java) => java.path === path,
                );
                if (
                  !next.startsWith("manual:") ||
                  !runtime ||
                  !javaCompatible(runtime, instance)
                )
                  return;
                java_overrides[instance.id] = { mode: "manual", path };
              }
              if (next === value) return;
              await onSave({ ...settings, java_overrides });
            });
          }}
        >
          <option value="follow">跟随全局设置</option>
          <option value="auto">自动选择</option>
          {catalog.runtimes.map((java) => (
            <option
              key={java.path}
              value={`manual:${java.path}`}
              disabled={!javaCompatible(java, instance)}
            >
              JDK {java.major} · {java.vendor} · {java.path}
              {!javaCompatible(java, instance) ? "（版本不兼容）" : ""}
            </option>
          ))}
          {unavailable.map((java) => (
            <option key={java.path} value={`manual:${java.path}`} disabled>
              {loading ? "正在检查 Java" : "Java 不可用"} · {java.path}
            </option>
          ))}
        </select>
        {(selectionError || error) && (
          <small className="ce-java-status" role="alert">
            {selectionError || error}
          </small>
        )}
      </div>
    </label>
  );
}
