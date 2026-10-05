/** Native receipt and policy authority are independent from root settings and
 * the launcher preferences CAS. No URL or game path participates in notices. */
export type MinecraftNoticeChannel = "release" | "snapshot";
export type MinecraftNoticeItem = {
  channel: MinecraftNoticeChannel;
  versionId: string;
  releasedAt: string;
};
export type MinecraftNoticeView = {
  state:
    | "disabled"
    | "baseline"
    | "unchanged"
    | "ready"
    | "unavailable"
    | "storageBlocked"
    | "stale";
  policyRevision: string;
  checkedAt: number | null;
  retryAt: number | null;
  cached: boolean;
  batch: { token: string; items: MinecraftNoticeItem[] } | null;
  warning: string | null;
};
function nonempty(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    !!value.trim() &&
    new TextEncoder().encode(value).length <= max &&
    !/[\x00-\x1f\x7f]/.test(value)
  );
}
function utcTimestamp(value: unknown) {
  if (typeof value !== "string") return false;
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|\+00:00)$/.exec(
      value,
    );
  if (!match) return false;
  const date = new Date(value);
  return (
    Number.isFinite(date.getTime()) &&
    [
      date.getUTCFullYear(),
      date.getUTCMonth() + 1,
      date.getUTCDate(),
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds(),
    ].every((part, index) => part === Number(match[index + 1]))
  );
}
/** Validate the whole batch before displaying or acknowledging any item. Native
 * still independently rechecks token/policy/history authority at acknowledgement. */
export function validMinecraftNoticeView(
  value: unknown,
  release: boolean,
  snapshot: boolean,
): value is MinecraftNoticeView {
  if (!value || typeof value !== "object") return false;
  const view = value as MinecraftNoticeView;
  if (
    ![
      "disabled",
      "baseline",
      "unchanged",
      "ready",
      "unavailable",
      "storageBlocked",
      "stale",
    ].includes(view.state) ||
    !nonempty(view.policyRevision, 512) ||
    typeof view.cached !== "boolean" ||
    !(view.warning === null || typeof view.warning === "string")
  )
    return false;
  if (
    ![view.checkedAt, view.retryAt].every(
      (time) =>
        time === null ||
        (typeof time === "number" && Number.isSafeInteger(time) && time >= 0),
    )
  )
    return false;
  if (view.state !== "ready") return view.batch === null;
  if (
    !view.batch ||
    !nonempty(view.batch.token, 512) ||
    !Array.isArray(view.batch.items) ||
    view.batch.items.length < 1 ||
    view.batch.items.length > 2
  )
    return false;
  const seen = new Set<string>();
  return view.batch.items.every((item) => {
    if (
      !item ||
      !["release", "snapshot"].includes(item.channel) ||
      seen.has(item.channel) ||
      !(item.channel === "release" ? release : snapshot) ||
      !nonempty(item.versionId, 128) ||
      /[/\\]/.test(item.versionId) ||
      !utcTimestamp(item.releasedAt)
    )
      return false;
    seen.add(item.channel);
    return true;
  });
}
