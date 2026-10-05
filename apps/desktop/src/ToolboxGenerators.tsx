import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { Api } from "./types";
import { t, serviceError, type MessageKey } from "./i18n";
import { Collapse } from "./Collapse";
import { InstanceOperationDialog } from "./instanceOperationUi";
import { achievementError, renderAchievement } from "./achievementImage";
type SkinSource = {
  sourceId: string;
  width: number;
  height: number;
  previewPngBase64: string;
};
type ImageOutcome = {
  status: "complete" | "cancelled" | "unavailable";
  path?: string | null;
  warning?: string | null;
};
type RenderedImage = { pngBase64: string; width: number; height: number };
type ImageError = { raw?: string; key?: MessageKey };
function pngData(value: string) {
  if (!value || !/^[A-Za-z0-9+/=]+$/.test(value))
    throw new Error("images.invalidPreview");
  return `data:image/png;base64,${value}`;
}
function imageError(error: unknown): ImageError {
  const key = String(error instanceof Error ? error.message : error);
  return [
    "images.assetUnavailable",
    "images.canvasUnavailable",
    "images.textTooLong",
    "images.invalidPreview",
  ].includes(key)
    ? { key: key as MessageKey }
    : { raw: key };
}
/** Generation never uploads skins or changes originals. Native source IDs bind
 * decoded skins; export chooser/publication lives in the bounded image service.
 * Every async response is tied to the API owner and input revision. */
export function ToolboxGenerators({
  api,
  native,
  disabled,
}: {
  api?: Api;
  native: boolean;
  disabled: boolean;
}) {
  const [achievementOpen, setAchievementOpen] = useState(true),
    [avatarOpen, setAvatarOpen] = useState(true);
  const [itemId, setItemId] = useState(""),
    [name, setName] = useState(""),
    [line1, setLine1] = useState(""),
    [line2, setLine2] = useState("");
  const [size, setSize] = useState(64),
    [skin, setSkin] = useState<(SkinSource & { owner: object }) | null>(null);
  const [avatar, setAvatar] = useState<{
    sourceId: string;
    size: number;
    url: string;
  } | null>(null);
  const [preview, setPreview] = useState<{
    owner: object;
    key: string;
    url: string;
  } | null>(null);
  const [activity, setActivity] = useState<string | null>(null),
    [error, setError] = useState<ImageError | null>(null),
    [outcome, setOutcome] = useState<ImageOutcome | null>(null);
  const owner = useRef({ api });
  if (owner.current.api !== api) owner.current = { api };
  const scope = owner.current,
    key = JSON.stringify([itemId, name, line1, line2]),
    avatarKey = JSON.stringify([skin?.sourceId, size]);
  const current = useRef({ key, avatarKey, native, disabled });
  current.current = { key, avatarKey, native, disabled };
  const live = useRef(true),
    pending = useRef<symbol | null>(null);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const valid = () => live.current && owner.current === scope;
  const input = { itemId, name, line1, line2 };
  const previewRef = useRef(preview);
  previewRef.current = preview;
  const visible =
    preview?.owner === scope && preview.key === key ? preview : null;
  const ownedSkin = skin?.owner === scope ? skin : null;
  const available = native && !!api,
    busy = !!activity;
  async function run<T>(
    kind: string,
    work: () => Promise<T>,
    apply: (value: T) => void,
    capture: "achievement" | "avatar" | null = null,
  ) {
    if (
      !valid() ||
      pending.current ||
      (kind !== "preview" &&
        (!current.current.native || current.current.disabled || !api))
    )
      return;
    const operation = Symbol();
    pending.current = operation;
    setActivity(kind);
    setError(null);
    setOutcome(null);
    const matches = () =>
      valid() &&
      pending.current === operation &&
      (capture === "achievement"
        ? current.current.key === key
        : capture === "avatar"
          ? current.current.avatarKey === avatarKey
          : true);
    try {
      const result = await work();
      if (matches()) apply(result);
    } catch (error) {
      if (matches()) setError(imageError(error));
    } finally {
      if (pending.current === operation) {
        pending.current = null;
        if (live.current) setActivity(null);
      }
    }
  }
  function generate(save: boolean) {
    if (busy || !valid()) return;
    const invalid = achievementError(input);
    if (invalid) {
      setError({ key: invalid });
      return;
    }
    void run(
      save ? "save-achievement" : "preview",
      async () => {
        const url = await renderAchievement(input);
        if (save) {
          if (
            !valid() ||
            current.current.key !== key ||
            !api ||
            !current.current.native ||
            current.current.disabled
          )
            return null;
          return api<ImageOutcome>("toolbox_png_export", {
            pngBase64: url.slice("data:image/png;base64,".length),
          });
        }
        return url;
      },
      (result) => {
        if (typeof result === "string")
          setPreview({ owner: scope, key, url: result });
        else if (result) setOutcome(result);
      },
      "achievement",
    );
  }
  function chooseSkin() {
    if (!api) return;
    void run(
      "choose-skin",
      () => api<SkinSource | null>("toolbox_skin_pick"),
      (source) => {
        if (!source) return;
        const url = pngData(source.previewPngBase64);
        if (!source.sourceId || source.width < 8 || source.height < 8)
          throw new Error("images.invalidPreview");
        setSkin({ ...source, owner: scope });
        setAvatar({ sourceId: source.sourceId, size: 64, url });
      },
    );
  }
  // A resize response only applies to the chosen source and requested size. A
  // failed render is not automatically retried in a loop; choose/size starts anew.
  const lastRender = useRef("");
  useEffect(() => {
    const renderKey = JSON.stringify([skin?.sourceId, size]);
    if (
      !ownedSkin ||
      !api ||
      !available ||
      disabled ||
      busy ||
      (avatar?.sourceId === ownedSkin.sourceId && avatar.size === size) ||
      lastRender.current === renderKey
    )
      return;
    lastRender.current = renderKey;
    void run(
      "render-avatar",
      () =>
        api<RenderedImage>("toolbox_avatar_render", {
          sourceId: ownedSkin!.sourceId,
          size,
        }),
      (image) => {
        if (image.width !== size || image.height !== size)
          throw new Error("images.invalidPreview");
        setAvatar({
          sourceId: ownedSkin!.sourceId,
          size,
          url: pngData(image.pngBase64),
        });
      },
      "avatar",
    );
  }, [skin, size, available, disabled, busy, api]);
  function saveAvatar() {
    if (api && ownedSkin)
      void run(
        "save-avatar",
        () =>
          api<ImageOutcome>("toolbox_avatar_export", {
            sourceId: ownedSkin!.sourceId,
            size,
          }),
        setOutcome,
        "avatar",
      );
  }
  const errorText = error
    ? error.key
      ? t(error.key)
      : serviceError(error.raw)
    : "";
  const resultText =
    outcome?.status === "unavailable"
      ? outcome.warning
        ? serviceError(outcome.warning)
        : t("common.unavailable")
      : outcome?.status === "complete"
        ? outcome.warning
          ? t("images.exportWarning", {
              path: outcome.path || "",
              warning: outcome.warning,
            })
          : t("images.exported", { path: outcome.path || "" })
        : "";
  return (
    <>
      <section className="ce-card toolbox-generator">
        <h2 className="ce-card-title toolbox-generator-title">
          <button
            className="ce-collapse"
            aria-expanded={achievementOpen}
            aria-controls="toolbox-achievement-fields"
            onClick={() => setAchievementOpen((open) => !open)}
          >
            <strong>{t("toolbox.achievement")}</strong>
            <ChevronDown
              size={16}
              className={`ce-disclosure-arrow ${achievementOpen ? "is-open" : ""}`}
              aria-hidden="true"
            />
          </button>
        </h2>
        <Collapse open={achievementOpen}>
          <div
            id="toolbox-achievement-fields"
            className="toolbox-generator-content toolbox-achievement-fields"
          >
            {(
              [
                ["toolbox.item", itemId, setItemId],
                ["toolbox.achievementName", name, setName],
                ["toolbox.line1", line1, setLine1],
                ["toolbox.line2", line2, setLine2],
              ] as const
            ).map(([label, value, setValue]) => (
              <label className="ce-row" key={label}>
                <span>{t(label)}</span>
                <input
                  className="ce-field"
                  value={value}
                  maxLength={128}
                  disabled={busy}
                  onChange={(event) => {
                    setValue(event.target.value);
                    setPreview(null);
                    setError(null);
                    setOutcome(null);
                  }}
                />
              </label>
            ))}
            <div className="toolbox-generator-actions">
              <button
                className="ce-button"
                disabled={busy}
                onClick={() => generate(false)}
              >
                {t("toolbox.previewAchievement")}
              </button>
              <button
                className="ce-button"
                disabled={busy || disabled || !available}
                title={!available ? t("common.desktopUnavailable") : undefined}
                onClick={() => generate(true)}
              >
                {t("toolbox.saveImage")}
              </button>
            </div>
            <p className="toolbox-generator-status">
              {t("images.supportedItems")}
            </p>
          </div>
        </Collapse>
      </section>
      <section className="ce-card toolbox-generator">
        <h2 className="ce-card-title toolbox-generator-title">
          <button
            className="ce-collapse"
            aria-expanded={avatarOpen}
            aria-controls="toolbox-avatar-fields"
            onClick={() => setAvatarOpen((open) => !open)}
          >
            <strong>{t("toolbox.avatar")}</strong>
            <ChevronDown
              size={16}
              className={`ce-disclosure-arrow ${avatarOpen ? "is-open" : ""}`}
              aria-hidden="true"
            />
          </button>
        </h2>
        <Collapse open={avatarOpen}>
          <div
            id="toolbox-avatar-fields"
            className="toolbox-generator-content toolbox-avatar-fields"
          >
            <label className="ce-row">
              <span>{t("toolbox.avatarSize")}</span>
              <select
                className="ce-field"
                value={size}
                disabled={busy}
                onChange={(event) => {
                  setSize(Number(event.target.value));
                  setError(null);
                  setOutcome(null);
                }}
              >
                {[8, 16, 32, 64, 128, 256, 512].map((value) => (
                  <option key={value} value={value}>
                    {value}x{value}
                  </option>
                ))}
              </select>
            </label>
            <div className="toolbox-generator-actions toolbox-avatar-actions">
              <button
                className="ce-button"
                disabled={busy || disabled || !available}
                title={!available ? t("common.desktopUnavailable") : undefined}
                onClick={chooseSkin}
              >
                {t("toolbox.skinChoose")}
              </button>
              <button
                className="ce-button"
                disabled={busy || disabled || !available || !ownedSkin}
                onClick={saveAvatar}
              >
                {t("toolbox.avatarSave")}
              </button>
            </div>
            {ownedSkin && avatar && avatar.sourceId === ownedSkin.sourceId && (
              <figure className="toolbox-image-preview">
                <img
                  src={avatar.url}
                  alt={t("images.avatarPreview")}
                  width={Math.min(size, 128)}
                  height={Math.min(size, 128)}
                />
                <figcaption>{t("images.localSkinHelp")}</figcaption>
              </figure>
            )}
          </div>
        </Collapse>
      </section>
      {(errorText || resultText) && (
        <p
          className={errorText ? "rd-name-error" : "toolbox-generator-status"}
          role={errorText ? "alert" : "status"}
        >
          {errorText || resultText}
        </p>
      )}
      {visible && (
        <InstanceOperationDialog
          title={t("toolbox.previewAchievement")}
          titleId="toolbox-image-preview-title"
          busy={busy}
          committing={activity === "save-achievement"}
          confirmLabel={t("toolbox.saveImage")}
          confirmDisabled={busy || disabled || !available}
          onConfirm={() => {
            if (valid() && previewRef.current === visible) generate(true);
          }}
          onClose={() => {
            if (
              valid() &&
              !pending.current &&
              current.current.key === visible.key
            ) {
              previewRef.current = null;
              setPreview(null);
            }
          }}
        >
          <figure className="toolbox-image-preview">
            <img src={visible.url} alt={t("images.achievementPreview")} />
          </figure>
          {errorText && (
            <p role="alert" className="rd-name-error">
              {errorText}
            </p>
          )}
          {resultText && <p role="status">{resultText}</p>}
        </InstanceOperationDialog>
      )}
    </>
  );
}
