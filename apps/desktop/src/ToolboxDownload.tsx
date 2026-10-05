import { useEffect, useRef, useState } from "react";
import type { Api } from "./types";
import { t, serviceError, type MessageKey } from "./i18n";
import { InstanceOperationDialog } from "./instanceOperationUi";
type DirectoryChoice = { token: string; directory: string };
type DownloadPreview = {
  token: string;
  urlDisplay: string;
  fileName: string;
  directory: string;
  target: string;
  preferencesRevision: string;
};
export function customDownloadError(
  url: string,
  fileName: string,
): MessageKey | null {
  try {
    const parsed = new URL(url);
    if (
      !["https:", "http:"].includes(parsed.protocol) ||
      parsed.hash ||
      parsed.username ||
      parsed.password ||
      !parsed.hostname
    )
      return "toolDownload.urlInvalid";
  } catch {
    return "toolDownload.urlInvalid";
  }
  return !fileName.trim() ||
    new TextEncoder().encode(fileName).length > 240 ||
    /[/\\\x00-\x1f\x7f]/.test(fileName) ||
    fileName === "." ||
    fileName === ".."
    ? "toolDownload.fileInvalid"
    : null;
}

/** Directory authority comes exclusively from the native chooser. Preparing
 * captures URL/name/directory policy without downloading; explicit confirmation
 * submits its token once and transfers cancellation to the shared task UI. */
export function ToolboxDownload({
  api,
  native,
  disabled,
  onTaskStart,
}: {
  api?: Api;
  native: boolean;
  disabled: boolean;
  onTaskStart?: (id: string) => void;
}) {
  const [url, setUrl] = useState(""),
    [fileName, setFileName] = useState(""),
    [directory, setDirectory] = useState<
      (DirectoryChoice & { owner: object }) | null
    >(null);
  const [preview, setPreview] = useState<{
      owner: object;
      key: string;
      value: DownloadPreview;
    } | null>(null),
    [error, setError] = useState<{ raw?: string; key?: MessageKey } | null>(
      null,
    );
  const [activity, setActivity] = useState<
    "choose" | "prepare" | "start" | "open" | null
  >(null);
  const owner = useRef({ api });
  if (owner.current.api !== api) owner.current = { api };
  const scope = owner.current,
    key = JSON.stringify([url, fileName, directory?.token]);
  const live = useRef(true),
    pending = useRef<symbol | null>(null);
  const current = useRef({ key, native, disabled, onTaskStart });
  current.current = { key, native, disabled, onTaskStart };
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const active = () => live.current && owner.current === scope;
  const chosen = directory?.owner === scope ? directory : null;
  const available = native && !!api;
  const blocked = !available || disabled || !!activity;
  const previewRef = useRef(preview);
  previewRef.current = preview;
  const visible =
    preview?.owner === scope && preview.key === key ? preview : null;
  async function run<T>(
    kind: NonNullable<typeof activity>,
    work: () => Promise<T>,
    apply: (value: T) => void,
    captureKey = false,
  ) {
    if (
      !active() ||
      !current.current.native ||
      current.current.disabled ||
      !api ||
      pending.current ||
      (captureKey && current.current.key !== key)
    )
      return;
    const operation = Symbol();
    pending.current = operation;
    setActivity(kind);
    setError(null);
    try {
      const value = await work();
      if (
        active() &&
        pending.current === operation &&
        (!captureKey || current.current.key === key)
      )
        apply(value);
    } catch (error) {
      if (
        active() &&
        pending.current === operation &&
        (!captureKey || current.current.key === key)
      ) {
        setError({ raw: String(error) });
        if (kind === "start") setPreview(null);
      }
    } finally {
      if (pending.current === operation) {
        pending.current = null;
        if (live.current) setActivity(null);
      }
    }
  }
  function choose() {
    if (api)
      void run(
        "choose",
        () => api<DirectoryChoice | null>("toolbox_download_choose"),
        (value) => {
          if (value) {
            setDirectory({ ...value, owner: scope });
            setPreview(null);
          }
        },
      );
  }
  function prepare() {
    if (!api || !chosen || blocked || current.current.key !== key) return;
    const validation = customDownloadError(url, fileName);
    if (validation) {
      setError({ key: validation });
      return;
    }
    void run(
      "prepare",
      () =>
        api<DownloadPreview>("toolbox_download_prepare", {
          request: { directoryToken: chosen!.token, url, fileName },
        }),
      (value) => {
        if (
          !value.token ||
          !value.preferencesRevision ||
          value.fileName !== fileName ||
          value.directory !== chosen!.directory ||
          !value.target.startsWith("/")
        ) {
          setError({ key: "toolDownload.changed" });
          return;
        }
        setPreview({ owner: scope, key, value });
      },
      true,
    );
  }
  function start() {
    if (
      !api ||
      !visible ||
      previewRef.current !== visible ||
      blocked ||
      pending.current ||
      current.current.key !== visible.key
    )
      return;
    const selected = visible;
    void run(
      "start",
      () =>
        api<{ id: string }>("toolbox_download_start", {
          token: selected.value.token,
        }),
      (value) => {
        if (!value.id) {
          setError({ key: "save.missingTask" });
          setPreview(null);
          return;
        }
        setPreview(null);
        current.current.onTaskStart?.(value.id);
      },
      true,
    );
  }
  return (
    <section className="ce-card">
      <h2 className="ce-card-title">{t("toolbox.download")}</h2>
      <div className="toolbox-content">
        <p>{t("toolbox.downloadHelp")}</p>
        <label className="ce-row">
          <span>{t("toolbox.url")}</span>
          <input
            className="ce-field"
            value={url}
            disabled={!!activity}
            maxLength={4096}
            onChange={(event) => {
              setUrl(event.target.value);
              setPreview(null);
              setError(null);
            }}
          />
        </label>
        <label className="ce-row">
          <span>{t("toolbox.destination")}</span>
          <div className="ce-inline">
            <input
              className="ce-field"
              value={chosen?.directory || ""}
              placeholder={t("toolDownload.chooseFirst")}
              readOnly
            />
            <button
              className="ce-text-button"
              disabled={blocked}
              title={!available ? t("common.desktopUnavailable") : undefined}
              onClick={choose}
            >
              {t("toolbox.choose")}
            </button>
          </div>
        </label>
        <label className="ce-row">
          <span>{t("toolbox.fileName")}</span>
          <input
            className="ce-field"
            value={fileName}
            disabled={!!activity}
            maxLength={255}
            onChange={(event) => {
              setFileName(event.target.value);
              setPreview(null);
              setError(null);
            }}
          />
        </label>
        <div className="toolbox-download-actions">
          <button
            className="ce-button"
            disabled={blocked || !chosen || !url || !fileName || !onTaskStart}
            onClick={prepare}
          >
            {activity === "prepare"
              ? t("toolDownload.preparing")
              : t("toolbox.start")}
          </button>
          <button
            className="ce-button"
            disabled={blocked || !chosen}
            onClick={() => {
              if (api && chosen)
                void run(
                  "open",
                  () =>
                    api("toolbox_download_open_directory", {
                      directoryToken: chosen!.token,
                    }),
                  () => {},
                );
            }}
          >
            {t("common.openFolder")}
          </button>
        </div>
        {error && !visible && (
          <p className="rd-name-error" role="alert">
            {error.key ? t(error.key) : serviceError(error.raw)}
          </p>
        )}
      </div>
      {visible && (
        <InstanceOperationDialog
          title={t("toolbox.download")}
          titleId="ce-custom-download-title"
          busy={!!activity}
          committing={activity === "start"}
          confirmLabel={t("toolbox.start")}
          confirmDisabled={blocked}
          onConfirm={start}
          onClose={() => {
            if (
              active() &&
              current.current.key === visible.key &&
              !pending.current &&
              activity !== "start"
            ) {
              previewRef.current = null;
              setPreview(null);
            }
          }}
        >
          <div
            className="ce-operation-plan"
            style={{ overflowWrap: "anywhere" }}
          >
            <p>
              {t("toolbox.url")}: {visible.value.urlDisplay}
            </p>
            <p>
              {t("toolbox.fileName")}: {visible.value.fileName}
            </p>
            <p>
              {t("save.target")}: {visible.value.target}
            </p>
          </div>
          <p>{t("toolDownload.reviewHelp")}</p>
          <p>{t("save.noOverwrite")}</p>
          {error && (
            <p className="rd-name-error" role="alert">
              {error.key ? t(error.key) : serviceError(error.raw)}
            </p>
          )}
        </InstanceOperationDialog>
      )}
    </section>
  );
}
