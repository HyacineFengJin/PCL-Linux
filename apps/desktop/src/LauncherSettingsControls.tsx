import { CeSelect } from "./CeSelect";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { Collapse } from "./Collapse";
import { createTranslator } from "./i18n";
import {
  defaultLauncherPreferenceView,
  type LauncherEffect,
  type LauncherPreferencePanelProps,
  type LauncherPreferencePatch,
  type LauncherAction,
} from "./launcherTypes";

export function LauncherCard({
  title,
  children,
  collapse = false,
}: {
  title?: string;
  children: ReactNode;
  collapse?: boolean;
}) {
  const [open, setOpen] = useState(true);
  return (
    <section className="ce-card extra-card">
      {title &&
        (collapse ? (
          <button
            className="extra-heading"
            onClick={() => setOpen(!open)}
            aria-expanded={open}
          >
            <h2 className="ce-card-title">{title}</h2>
            <ChevronDown
              size={17}
              className={`ce-disclosure-arrow ${open ? "is-open" : ""}`}
            />
          </button>
        ) : (
          <h2 className="ce-card-title">{title}</h2>
        ))}
      {collapse ? <Collapse open={open}>{children}</Collapse> : children}
    </section>
  );
}
export function LauncherField({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="extra-row">
      <span>{label}</span>
      {children}
    </label>
  );
}
export function LauncherCheck({
  children,
  value,
  disabled,
  reason,
  onChange,
}: {
  children: ReactNode;
  value: boolean;
  disabled?: boolean;
  reason?: string;
  onChange: (value: boolean) => void;
}) {
  return (
    <label
      className="ce-check extra-check"
      title={disabled ? reason : undefined}
    >
      <input
        type="checkbox"
        checked={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      {children}
    </label>
  );
}
export function LauncherSelect<T extends string>({
  label,
  value,
  options,
  disabled,
  reason,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly {
    value: T;
    label: string;
    disabled?: boolean;
    reason?: string;
  }[];
  disabled?: boolean;
  reason?: string;
  onChange: (value: T) => void;
}) {
  return (
    <CeSelect
      className="ce-field"
      aria-label={label}
      value={value}
      disabled={disabled}
      title={disabled ? reason : undefined}
      onChange={(e) => {
        if (
          !disabled &&
          !options.some((o) => o.value === e.target.value && o.disabled)
        )
          onChange(e.target.value as T);
      }}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value} disabled={o.disabled}>
          {o.label}
        </option>
      ))}
    </CeSelect>
  );
}
export function LauncherRadios<T extends string>({
  label,
  value,
  options,
  disabled,
  reason,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly {
    value: T;
    label: string;
    disabled?: boolean;
    reason?: string;
  }[];
  disabled?: boolean;
  reason?: string;
  onChange: (value: T) => void;
}) {
  return (
    <div className="extra-radios" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <label
          className="ce-memory-mode"
          key={o.value}
          title={disabled ? reason : o.disabled ? o.reason : undefined}
        >
          <input
            type="radio"
            name={label}
            checked={value === o.value}
            disabled={!!disabled || !!o.disabled}
            onChange={() => {
              if (!disabled && !o.disabled) onChange(o.value);
            }}
          />
          {o.label}
        </label>
      ))}
    </div>
  );
}

/** Only commit an edited value on release/blur. Multiple completion events from
 * the same gesture cannot create duplicate writes against one transport revision.
 */
export function LauncherRange({
  label,
  value,
  min,
  max,
  step = 1,
  unit = "",
  disabled,
  reason,
  onCommit,
  formatNumber = String,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  disabled?: boolean;
  reason?: string;
  onCommit: (value: number) => void;
  formatNumber?: (value: number) => string;
}) {
  const [draft, setDraft] = useState(value);
  const committed = useRef(value);
  useEffect(() => {
    if (!disabled) {
      committed.current = value;
      setDraft(value);
    }
  }, [value, disabled]);
  function commit() {
    if (disabled || draft === committed.current) return;
    committed.current = draft;
    onCommit(draft);
  }
  return (
    <div
      style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}
    >
      <input
        className="extra-range"
        aria-label={label}
        aria-valuetext={`${formatNumber(draft)}${unit}`}
        style={
          {
            "--range-fill": `${(100 * (draft - min)) / (max - min)}%`,
          } as React.CSSProperties
        }
        type="range"
        min={min}
        max={max}
        step={step}
        value={draft}
        disabled={disabled}
        title={disabled ? reason : `${formatNumber(draft)}${unit}`}
        onChange={(e) => setDraft(Number(e.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
      />
      <output
        style={{
          minWidth: 48,
          textAlign: "right",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {formatNumber(draft)}
        {unit}
      </output>
    </div>
  );
}
export function LauncherText({
  label,
  value,
  disabled,
  reason,
  placeholder,
  onCommit,
}: {
  label: string;
  value: string;
  disabled?: boolean;
  reason?: string;
  placeholder?: string;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const committed = useRef(value);
  useEffect(() => {
    if (!disabled) {
      setDraft(value);
      committed.current = value;
    }
  }, [value, disabled]);
  function commit() {
    if (disabled || draft === committed.current) return;
    committed.current = draft;
    onCommit(draft);
  }
  return (
    <input
      className="ce-field"
      aria-label={label}
      value={draft}
      disabled={disabled}
      title={disabled ? reason : undefined}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        }
      }}
    />
  );
}

/** Panels submit partial edits; the parent owns global adoption and revision
 * refresh. Root changes or an unmounted settings panel must not own this state.
 */
export function useLauncherPreferenceEditor(
  props: LauncherPreferencePanelProps,
) {
  const fallback = useRef(defaultLauncherPreferenceView());
  const view = props.preferences || fallback.current;
  const tr = createTranslator(view.preferences.localization);
  const [pending, setPending] = useState(false);
  const admission = useRef(false);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const busy = !!props.preferenceBusy || pending;
  const current = useRef({ props, view, busy, tr });
  current.current = { props, view, busy, tr };
  const connected = () =>
    !!current.current.props.preferences &&
    !!current.current.props.onPatch &&
    !!current.current.view.revision &&
    !current.current.view.warning;
  const supports = (effect: LauncherEffect) =>
    !!current.current.props.supportedEffects?.includes(effect);
  const reason = (
    effect: LauncherEffect,
    unavailable = current.current.tr.t("common.effectUnavailable"),
  ) =>
    !connected()
      ? current.current.view.warning
        ? current.current.tr.t("common.storeWarning", {
            warning: current.current.view.warning,
          })
        : current.current.tr.t("common.previewReadonly")
      : !supports(effect)
        ? unavailable
        : current.current.busy
          ? current.current.tr.t("common.saving")
          : undefined;
  const disabled = (effect: LauncherEffect) =>
    !live.current || !connected() || !supports(effect) || current.current.busy;
  async function run(work: () => Promise<unknown>) {
    if (!live.current || admission.current || current.current.busy) return;
    admission.current = true;
    setPending(true);
    try {
      await work();
    } catch (error) {
      current.current.props.onNotify(current.current.tr.serviceError(error));
    } finally {
      admission.current = false;
      if (live.current) setPending(false);
    }
  }
  function patch(effect: LauncherEffect, value: LauncherPreferencePatch) {
    if (
      view.revision !== current.current.view.revision ||
      disabled(effect) ||
      !current.current.props.onPatch
    )
      return;
    void run(() => current.current.props.onPatch!(value));
  }
  function action(effect: LauncherEffect, value: LauncherAction) {
    if (
      view.revision !== current.current.view.revision ||
      disabled(effect) ||
      !current.current.props.onLauncherAction
    )
      return;
    void run(() => current.current.props.onLauncherAction!(value));
  }
  return {
    translator: tr,
    view,
    prefs: view.preferences,
    busy,
    disabled,
    reason,
    patch,
    action,
    actionDisabled: (effect: LauncherEffect) =>
      disabled(effect) || !current.current.props.onLauncherAction,
    actionReason: (effect: LauncherEffect, unavailable?: string) =>
      reason(effect, unavailable) ||
      (!current.current.props.onLauncherAction
        ? current.current.tr.t("common.desktopUnavailable")
        : undefined),
  };
}
