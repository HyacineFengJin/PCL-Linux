import { CeSelect } from "./CeSelect";
import { t, formatNumber } from "./i18n";
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
    unavailable.unshift({ path: override.path, error: t("java.missing") });
  let selectionError = "";
  if (!loading && effective.mode === "manual") {
    const runtime = catalog.runtimes.find(
      (java) => java.path === effective.path,
    );
    if (!runtime)
      selectionError =
        catalog.unavailable.find((java) => java.path === effective.path)
          ?.error || t("java.chooseOther");
    else if (!javaCompatible(runtime, instance))
      selectionError = t(
        requiresExactJava(instance)
          ? "java.requiresExact"
          : "java.requiresNewer",
        { version: formatNumber(instance.java_major) },
      );
    if (selectionError && !override)
      selectionError = t("java.globalError", { error: selectionError });
  }
  return (
    <label className="ce-row">
      <span>{t("java.game")}</span>
      <div className="ce-java-select-control">
        <CeSelect
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
          <option value="follow">{t("ui.followGlobal")}</option>
          <option value="auto">{t("java.auto")}</option>
          {catalog.runtimes.map((java) => (
            <option
              key={java.path}
              value={`manual:${java.path}`}
              disabled={!javaCompatible(java, instance)}
            >
              JDK {formatNumber(java.major)} · {java.vendor} · {java.path}
              {!javaCompatible(java, instance) ? t("java.incompatible") : ""}
            </option>
          ))}
          {unavailable.map((java) => (
            <option key={java.path} value={`manual:${java.path}`} disabled>
              {loading ? t("java.checking") : t("java.unavailable")} ·{" "}
              {java.path}
            </option>
          ))}
        </CeSelect>
        {(selectionError || error) && (
          <small className="ce-java-status" role="alert">
            {selectionError || error}
          </small>
        )}
      </div>
    </label>
  );
}
