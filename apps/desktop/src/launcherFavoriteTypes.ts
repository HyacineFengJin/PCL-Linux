/** Launcher-owned community identities. Metadata is authoritative native data;
 * no URL or supplied title grants write or provider request authority. */
export type LauncherFavoriteType =
  "mod" | "resourcepack" | "shader" | "modpack";
export type LauncherFavoriteEntry = {
  provider: "modrinth";
  projectId: string;
  folderId: string;
  title: string;
  projectType: LauncherFavoriteType;
  iconUrl: string | null;
  summary: string;
};
export type LauncherFavoriteView = {
  revision: string;
  folders: { id: string; name: string }[];
  entries: LauncherFavoriteEntry[];
  warning: string | null;
};
export type LauncherFavoriteChange =
  | { kind: "save_many"; projectIds: string[]; folderId: string }
  | { kind: "save"; projectId: string; folderId: string }
  | { kind: "remove"; projectId: string }
  | { kind: "create_folder"; name: string }
  | { kind: "rename_folder"; folderId: string; name: string }
  | { kind: "remove_folder"; folderId: string };
