export type Instance = {
  id: string;
  minecraft_version: string;
  loader: string;
  java_major: number;
  mod_count: number;
  isolated: boolean;
};
export type Settings = {
  root: string;
  player: string;
  memory_gib: number;
  selected: string | null;
  overrides: Record<string, number>;
};
export type Api = <T>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>;
