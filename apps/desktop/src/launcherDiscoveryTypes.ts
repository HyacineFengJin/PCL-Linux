/** Discovery returns project releases and approved link identities, never raw
 * clipboard text or executable home content. Keep native camelCase wire names. */
export type LauncherAnnouncementView = {
  scope: "all" | "important" | "none";
  state: "disabled" | "ready" | "empty" | "rateLimited" | "unavailable";
  items: {
    id: string;
    title: string;
    text: string;
    url: string;
    publishedAt: string | null;
    prerelease: boolean;
  }[];
  fetchedAt: number | null;
  retryAt: number | null;
  cached: boolean;
  truncated: boolean;
  message: string | null;
};
export type LauncherClipboardLink = {
  kind: "mod" | "resourcepack" | "shader" | "modpack";
  projectIdOrSlug: string;
  url: string;
};
