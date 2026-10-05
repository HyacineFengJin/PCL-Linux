export type ResourceBrowseRequest = {
  section: "mods" | "resourcepacks" | "shaderpacks";
  version?: string;
  loader?: string;
};
/** Only known Modrinth mod loader facets are derived from native profile text.
 * Packs/shaders keep their game version without pretending Fabric is a shader
 * loader. These filters browse resources; they grant no install authority. */
export function resourceBrowseRequest(
  section: string,
  minecraft: string,
  profileLoader: string,
): ResourceBrowseRequest | null {
  if (
    section !== "mods" &&
    section !== "resourcepacks" &&
    section !== "shaderpacks"
  )
    return null;
  const loader =
    section === "mods"
      ? ["neoforge", "forge", "fabric", "quilt"].find((value) =>
          new RegExp(`(^|[ /+,])${value}([ /+,:]|$)`, "i").test(profileLoader),
        )
      : undefined;
  return { section, version: minecraft || undefined, loader };
}
