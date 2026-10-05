import { useContext, useEffect, useRef, useState } from "react";
import { Box, Settings, Heart } from "lucide-react";
import {
  LauncherFavoritesContext,
  favoriteFolderName,
} from "./useLauncherFavorites";
import { t, serviceError, formatNumber } from "./i18n";
import { InstanceOperationDialog } from "./instanceOperationUi";
import "./launcher-favorites.css";

function safeFavoriteIcon(value: string | null) {
  try {
    const url = new URL(value || "");
    return url.protocol === "https:" && url.hostname === "cdn.modrinth.com"
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}
/** Existing folder selector and CE resource rows; user folder names and native
 * publisher text stay literal. Folder management reuses existing CE dialogs. */
export function Favorites() {
  const controller = useContext(LauncherFavoritesContext);
  const [folderId, setFolderId] = useState("default"),
    [settings, setSettings] = useState<object | null>(null);
  const [name, setName] = useState(""),
    [renaming, setRenaming] = useState<string | null>(null),
    [error, setError] = useState("");
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const formKey = JSON.stringify([folderId, name, renaming]);
  const currentForm = useRef(formKey);
  currentForm.current = formKey;
  const pendingFolder = useRef(false);
  const identity = useRef(controller?.owner);
  identity.current = controller?.owner;
  const ownerScope = controller?.owner;
  const current = () => live.current && identity.current === ownerScope;
  const view = controller?.view;
  const folders = view?.folders || [{ id: "default", name: "" }];
  useEffect(() => {
    if (!folders.some((folder) => folder.id === folderId))
      setFolderId("default");
  }, [folders, folderId]);
  const entries =
    view?.entries.filter((entry) => entry.folderId === folderId) || [];
  const blocked =
    !controller?.native ||
    !view?.revision ||
    !!view.warning ||
    controller.busy ||
    controller.loading;
  const selectedFolder = folders.find((folder) => folder.id === folderId);
  async function saveFolder() {
    if (
      !current() ||
      !settings ||
      settingsRef.current !== settings ||
      currentForm.current !== formKey ||
      pendingFolder.current ||
      blocked ||
      !name.trim() ||
      !controller
    )
      return;
    pendingFolder.current = true;
    const owner = controller;
    setError("");
    try {
      await owner.change(
        renaming
          ? { kind: "rename_folder", folderId: renaming, name }
          : { kind: "create_folder", name },
      );
      if (current() && settingsRef.current === settings) {
        setName("");
        setRenaming(null);
      }
    } catch (error) {
      if (current() && settingsRef.current === settings)
        setError(String(error));
    } finally {
      pendingFolder.current = false;
    }
  }
  async function removeFolder() {
    if (
      !current() ||
      !settings ||
      settingsRef.current !== settings ||
      currentForm.current !== formKey ||
      pendingFolder.current ||
      blocked ||
      !controller ||
      folderId === "default" ||
      entries.length
    )
      return;
    pendingFolder.current = true;
    try {
      await controller.change({ kind: "remove_folder", folderId });
    } catch (error) {
      if (current() && settingsRef.current === settings)
        setError(String(error));
    } finally {
      pendingFolder.current = false;
    }
  }
  return (
    <div className="ce-state-stage ce-favorites-empty ce-favorites-page">
      <div className="ce-card ce-favorites-toolbar">
        <select
          className="ce-field"
          aria-label={t("favorites.folder")}
          value={folderId}
          disabled={!view?.revision || controller?.loading}
          onChange={(event) => setFolderId(event.target.value)}
        >
          {folders.map((folder) => (
            <option key={folder.id} value={folder.id}>
              {favoriteFolderName(folder)}
            </option>
          ))}
        </select>
        <button
          className="icon-button"
          disabled={!view?.revision || controller?.loading}
          title={t("favorites.settings")}
          aria-label={t("favorites.settings")}
          onClick={() => {
            setSettings({});
            setError("");
          }}
        >
          <Settings size={16} />
        </button>
      </div>
      {controller?.loading ? (
        <section className="ce-card ce-state-box">
          <p role="status">{t("favorites.loading")}</p>
        </section>
      ) : controller?.error && !view?.revision ? (
        <section className="ce-card ce-state-box">
          <p role="alert">{serviceError(controller.error)}</p>
          <button
            className="ce-button"
            onClick={() => void controller.reload(true)}
          >
            {t("ui.reload")}
          </button>
        </section>
      ) : !entries.length ? (
        <section className="ce-card ce-state-box">
          <h2>{t("favorites.empty")}</h2>
          <p>{t("favorites.help")}</p>
        </section>
      ) : (
        <section className="ce-card ce-favorites-list">
          {entries.map((entry) => (
            <button
              key={entry.projectId}
              className="resource-row ce-favorite-row"
              onClick={() => controller?.open(entry)}
            >
              <span className="resource-icon">
                {safeFavoriteIcon(entry.iconUrl) ? (
                  <img
                    src={safeFavoriteIcon(entry.iconUrl)}
                    alt=""
                    loading="lazy"
                  />
                ) : (
                  <Box size={29} />
                )}
              </span>
              <span className="ce-favorite-text">
                <strong>{entry.title}</strong>
                <small>{entry.summary}</small>
                <small>
                  Modrinth · {t(`favorites.type.${entry.projectType}`)}
                </small>
              </span>
            </button>
          ))}
        </section>
      )}
      {view?.warning && (
        <div className="extra-paragraph">
          <p role="alert">{serviceError(view.warning)}</p>
          <button
            className="ce-button"
            disabled={controller?.busy || controller?.loading}
            onClick={() => void controller?.reload(true)}
          >
            {t("ui.reload")}
          </button>
        </div>
      )}
      {settings && (
        <InstanceOperationDialog
          title={t("favorites.settings")}
          titleId="ce-favorite-settings-title"
          busy={!!controller?.busy}
          committing={!!controller?.busy}
          confirmLabel={
            renaming ? t("favorites.renameFolder") : t("favorites.createFolder")
          }
          confirmDisabled={blocked || !name.trim()}
          onConfirm={() => void saveFolder()}
          onClose={() => {
            if (
              !current() ||
              pendingFolder.current ||
              settingsRef.current !== settings
            )
              return;
            settingsRef.current = null;
            setSettings(null);
            setRenaming(null);
            setName("");
          }}
        >
          <label className="ce-row">
            <span>{t("favorites.folder")}</span>
            <select
              className="ce-field"
              value={folderId}
              disabled={controller?.busy}
              onChange={(event) => {
                setFolderId(event.target.value);
                setRenaming(null);
                setName("");
              }}
            >
              {folders.map((folder) => (
                <option key={folder.id} value={folder.id}>
                  {favoriteFolderName(folder)}
                </option>
              ))}
            </select>
          </label>
          <div className="ce-actions">
            <button
              className="ce-button"
              disabled={blocked || folderId === "default"}
              onClick={() => {
                setRenaming(folderId);
                setName(selectedFolder?.name || "");
              }}
            >
              {t("favorites.renameFolder")}
            </button>
            <button
              className="ce-button"
              disabled={blocked || folderId === "default" || entries.length > 0}
              title={entries.length ? t("favorites.folderNotEmpty") : undefined}
              onClick={() => void removeFolder()}
            >
              {t("favorites.removeFolder")}
            </button>
          </div>
          <label className="ce-row">
            <span>
              {renaming ? t("favorites.newName") : t("favorites.folderName")}
            </span>
            <input
              className="ce-field"
              value={name}
              maxLength={128}
              disabled={controller?.busy}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          {renaming && (
            <button
              className="ce-text-button"
              disabled={controller?.busy}
              onClick={() => {
                setRenaming(null);
                setName("");
              }}
            >
              {t("favorites.createInstead")}
            </button>
          )}
          {(error || controller?.error) && (
            <p className="rd-name-error" role="alert">
              {serviceError(error || controller?.error)}
            </p>
          )}
        </InstanceOperationDialog>
      )}
    </div>
  );
}

/** Review selects the destination folder for authoritative save/move. The
 * captured project identity and current context invalidate older page handlers. */
export function ResourceFavorite({
  projectId,
  projectIds,
  unavailableKey = "favorites.unavailable",
  supported,
  contextKey,
}: {
  projectId: string;
  projectIds?: string[];
  unavailableKey?: import("./i18n").MessageKey;
  supported: boolean;
  contextKey: string;
}) {
  const controller = useContext(LauncherFavoritesContext);
  const [choice, setChoice] = useState<{
      scope: object;
      folderId: string;
    } | null>(null),
    [error, setError] = useState("");
  const projects = projectIds ? [...new Set(projectIds)].sort() : [projectId];
  const projectKey = JSON.stringify(projects);
  const identity = useRef({
    owner: controller?.owner,
    projectId: projectKey,
    contextKey,
  });
  if (
    identity.current.owner !== controller?.owner ||
    identity.current.projectId !== projectKey ||
    identity.current.contextKey !== contextKey
  )
    identity.current = {
      owner: controller?.owner,
      projectId: projectKey,
      contextKey,
    };
  const scope = identity.current;
  const live = useRef(true),
    pending = useRef(false);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const entry = controller?.view.entries.find(
    (entry) => entry.projectId === projectId,
  );
  const blocked =
    !supported ||
    !projects.length ||
    projects.length > 128 ||
    !controller?.native ||
    !controller.view.revision ||
    !!controller.view.warning ||
    controller.busy ||
    controller.loading;
  const choiceRef = useRef(choice);
  choiceRef.current = choice;
  const visible = choice?.scope === scope ? choice : null;
  async function submit(remove = false) {
    if (
      identity.current !== scope ||
      !live.current ||
      pending.current ||
      blocked ||
      !controller ||
      !visible ||
      choiceRef.current !== visible
    )
      return;
    pending.current = true;
    try {
      await controller.change(
        remove
          ? { kind: "remove", projectId }
          : projectIds
            ? {
                kind: "save_many",
                projectIds: projects,
                folderId: visible.folderId,
              }
            : { kind: "save", projectId, folderId: visible.folderId },
      );
      if (
        live.current &&
        identity.current === scope &&
        choiceRef.current === visible
      ) {
        choiceRef.current = null;
        setChoice(null);
      }
    } catch (error) {
      if (live.current && identity.current === scope) setError(String(error));
    } finally {
      pending.current = false;
    }
  }
  return (
    <>
      <button
        disabled={blocked}
        title={blocked ? t(unavailableKey) : undefined}
        aria-pressed={
          projects.length > 0 &&
          projects.every((id) =>
            controller?.view.entries.some((entry) => entry.projectId === id),
          )
        }
        onClick={() => {
          if (!blocked && identity.current === scope) {
            setError("");
            setChoice({ scope, folderId: entry?.folderId || "default" });
          }
        }}
      >
        <Heart size={14} />
        {t("resource.favorite")}
      </button>
      {visible && (
        <InstanceOperationDialog
          title={t("resource.favorite")}
          titleId="ce-resource-favorite-title"
          busy={!!controller?.busy}
          committing={!!controller?.busy}
          confirmLabel={entry ? t("favorites.move") : t("favorites.save")}
          confirmDisabled={blocked}
          onConfirm={() => void submit()}
          onClose={() => {
            if (identity.current === scope && !pending.current) {
              choiceRef.current = null;
              setChoice(null);
            }
          }}
        >
          {projectIds && (
            <p>
              {t("favorites.bulkCount", {
                count: formatNumber(projects.length),
              })}
            </p>
          )}
          <label className="ce-row">
            <span>{t("favorites.folder")}</span>
            <select
              className="ce-field"
              value={visible.folderId}
              disabled={controller?.busy}
              onChange={(event) => {
                if (identity.current === scope && !pending.current)
                  setChoice({ scope, folderId: event.target.value });
              }}
            >
              {controller?.view.folders.map((folder) => (
                <option key={folder.id} value={folder.id}>
                  {favoriteFolderName(folder)}
                </option>
              ))}
            </select>
          </label>
          {entry && !projectIds && (
            <button
              className="ce-button"
              disabled={blocked}
              onClick={() => void submit(true)}
            >
              {t("favorites.remove")}
            </button>
          )}
          {error && (
            <p className="rd-name-error" role="alert">
              {serviceError(error)}
            </p>
          )}
        </InstanceOperationDialog>
      )}
    </>
  );
}
