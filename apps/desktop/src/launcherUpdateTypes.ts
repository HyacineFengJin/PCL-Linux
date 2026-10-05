/** Public update status; opaque release tokens retain native selection identity. */
export type LauncherUpdateView = {
  current: {
    version: string;
    commit: string | null;
    executable: string;
    install_channel: "portable" | "package_managed" | "unmanaged";
    architecture: "x86_64" | "aarch64" | "unsupported";
  };
  state:
    | "idle"
    | "checking"
    | "available"
    | "latest"
    | "no_compatible_release"
    | "error";
  message: string | null;
  release: {
    token: string;
    tag: string;
    version: string;
    commit: string;
    prerelease: boolean;
    artifact_name: string;
    architecture: string;
    bytes: number;
    sha256: string;
    elf_header_verified: boolean;
  } | null;
  download: {
    state: "idle" | "downloading" | "staged" | "cancelled" | "error";
    received_bytes: number;
    total_bytes: number;
    message: string | null;
  };
  plan: {
    version: string;
    commit: string;
    artifact_name: string;
    architecture: string;
    bytes: number;
    sha256: string;
    destination: string | null;
    install_channel: string;
    original_sha256: string | null;
    can_apply: boolean;
    restart_required: boolean;
    reason: string;
  } | null;
  installation: {
    state:
      | "idle"
      | "applying"
      | "applied"
      | "rolling_back"
      | "rolled_back"
      | "recovery_required"
      | "error";
    disk_build: {
      version: string;
      commit: string | null;
      sha256: string;
    } | null;
    restart_required: boolean;
    rollback: {
      token: string;
      original_version: string;
      applied_version: string;
      can_rollback: boolean;
    } | null;
    warning: string | null;
  };
};
