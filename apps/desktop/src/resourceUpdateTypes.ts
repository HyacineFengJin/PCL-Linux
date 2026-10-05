import type {
  ResourceInstallFile,
  ResourceInstallPlan,
  ResourceInstallTarget,
} from "./resourceInstallPlan";

export type ResourceFile = { file_name: string; fingerprint: string };
export type ResourceUpdateTarget = ResourceInstallTarget;
export type ResourceUpdateEntry = ResourceFile & {
  enabled: boolean;
  project_id: string | null;
  title: string | null;
  old_version_id: string | null;
  old_version: string | null;
  new_version_id: string | null;
  new_version: string | null;
  status: "update_available" | "up_to_date" | "unknown" | "blocked";
  reason: string | null;
};
export type ResourceUpdateCheck = Pick<
  ResourceInstallPlan,
  "root_id" | "instance_id" | "minecraft_version" | "loader" | "warnings"
> & {
  entries: ResourceUpdateEntry[];
};
export type ResourceReplacement = {
  kind: "mods" | "resourcepacks" | "shaderpacks";
  old_file_name: string;
  old_fingerprint: string;
  old_sha512: string;
  new_file_name: string;
  enabled: boolean;
  project_id: string;
  title: string;
  old_version_id: string;
  old_version: string;
  new_version_id: string;
  new_version: string;
  size: number;
  sha512: string;
  required: boolean;
};
export type ResourceUpdatePlan = Pick<
  ResourceInstallPlan,
  | "root_id"
  | "instance_id"
  | "minecraft_version"
  | "loader"
  | "revision"
  | "dependencies"
  | "warnings"
  | "total_bytes"
  | "download_bytes"
> & {
  replacements: ResourceReplacement[];
  adds: ResourceInstallFile[];
  reuse: ResourceInstallFile[];
};
export type ResourceUpdateHistory = {
  id: string;
  files: string[];
  created_at: number;
};

/** The caller submits only exact old file identities. Version choices, download
 * URLs, hashes, replacement names and compatibility stay backend authority. */
export function resourceUpdateFiles(files: ResourceFile[]): ResourceFile[] {
  return files.map(({ file_name, fingerprint }) => ({
    file_name,
    fingerprint,
  }));
}

function checkTarget(
  value: ResourceUpdateCheck | ResourceUpdatePlan,
  rootId: string,
  target: ResourceUpdateTarget,
) {
  const loader = target.loader.split(/\s+/)[0].toLowerCase();
  if (
    value.root_id !== rootId ||
    value.instance_id !== target.id ||
    value.minecraft_version !== target.minecraft_version ||
    value.loader !== (loader === "vanilla" ? "minecraft" : loader)
  )
    throw new Error("更新结果与当前实例或游戏目录不一致，请重新读取资源");
}

export function checkResourceUpdates(
  value: ResourceUpdateCheck,
  rootId: string,
  target: ResourceUpdateTarget,
  files: ResourceFile[],
) {
  checkTarget(value, rootId, target);
  if (!Array.isArray(value.entries) || !Array.isArray(value.warnings))
    throw new Error("更新检测结果无效，请重新检查");
  const identities = new Map(
    files.map((file) => [file.file_name, file.fingerprint]),
  );
  const seen = new Set<string>();
  for (const entry of value.entries) {
    if (
      seen.has(entry.file_name) ||
      identities.get(entry.file_name) !== entry.fingerprint ||
      !["update_available", "up_to_date", "unknown", "blocked"].includes(
        entry.status,
      ) ||
      (entry.status === "update_available" &&
        (!entry.project_id ||
          !entry.old_version_id ||
          !entry.new_version_id ||
          !entry.new_version))
    )
      throw new Error("本地资源或更新信息已变化，请重新读取资源");
    seen.add(entry.file_name);
  }
  if (files.some((file) => !seen.has(file.file_name)))
    throw new Error("本地资源已变化，请重新读取资源后检查更新");
}

/** Confirmation ownership protects the visible selection. The backend still
 * re-prepares every fingerprint/revision at task admission and publication. */
export function checkResourceUpdatePlan(
  plan: ResourceUpdatePlan,
  rootId: string,
  target: ResourceUpdateTarget,
  files: ResourceFile[],
) {
  checkTarget(plan, rootId, target);
  if (
    !plan.revision ||
    !Array.isArray(plan.replacements) ||
    !Array.isArray(plan.adds) ||
    !Array.isArray(plan.reuse) ||
    !Array.isArray(plan.warnings) ||
    !plan.replacements.length ||
    !files.length
  )
    throw new Error("更新计划无效，请重新检查");
  const chosen = new Map(
    files.map((file) => [file.file_name, file.fingerprint]),
  );
  const seen = new Set<string>();
  for (const file of plan.replacements) {
    const selected = chosen.has(file.old_file_name);
    if (
      seen.has(file.old_file_name) ||
      !file.old_fingerprint ||
      !file.new_file_name ||
      !["mods", "resourcepacks", "shaderpacks"].includes(file.kind) ||
      (selected &&
        (file.kind !== "mods" ||
          chosen.get(file.old_file_name) !== file.old_fingerprint ||
          file.required)) ||
      (!selected && !file.required) ||
      file.enabled === file.old_file_name.endsWith(".disabled") ||
      file.enabled === file.new_file_name.endsWith(".disabled")
    )
      throw new Error("更新计划与所选文件或禁用状态不一致，请重新检查");
    seen.add(file.old_file_name);
  }
  if (files.some((file) => !seen.has(file.file_name)))
    throw new Error("更新计划缺少所选文件，请重新检查");
  const all = [...plan.replacements, ...plan.adds, ...plan.reuse];
  if (
    !Number.isSafeInteger(plan.total_bytes) ||
    !Number.isSafeInteger(plan.download_bytes) ||
    plan.download_bytes < 0 ||
    plan.total_bytes < plan.download_bytes ||
    all.some(
      (file) =>
        !["mods", "resourcepacks", "shaderpacks"].includes(file.kind) ||
        !Number.isSafeInteger(file.size) ||
        file.size < 0,
    ) ||
    plan.adds.some((file) => file.reused) ||
    plan.reuse.some((file) => !file.reused) ||
    all.reduce((sum, file) => sum + file.size, 0) !== plan.total_bytes ||
    [...plan.replacements, ...plan.adds].reduce(
      (sum, file) => sum + file.size,
      0,
    ) !== plan.download_bytes
  )
    throw new Error("更新计划的文件大小或复用状态无效，请重新检查");
}
