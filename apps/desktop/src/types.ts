export type InstanceMetadata = {
  description: string;
  favorite: boolean;
  icon: "auto" | "grass" | "forge" | "neoforge" | "command" | "steve";
  category: "auto" | "vanilla" | "forge" | "neoforge" | "fabric" | "quilt";
};
export type MetaView = InstanceMetadata & { revision: string };
export type Instance = {
  id: string;
  minecraft_version: string;
  loader: string;
  java_major: number;
  mod_count: number;
  isolated: boolean;
  metadata?: InstanceMetadata;
  metadata_revision?: string;
};
export type Settings = {
  revision?: string;
  root_id?: string | null;
  root: string;
  player: string;
  memory_gib: number;
  selected: string | null;
  overrides: Record<string, number>;
};
export type RootSummary = {
  id: string;
  name: string;
  path: string;
  selected: string | null;
  overrides?: Record<string, number>;
  available: boolean;
  error?: string | null;
};
export type Api = <T>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>;
