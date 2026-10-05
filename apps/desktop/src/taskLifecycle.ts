import type { DownloadStatus } from "./DownloadPanel";

export function taskIdentity(status: DownloadStatus): string {
  return (
    status.task_id ||
    `${status.root_id || status.root_path || ""}:${status.version || ""}`
  );
}

export function taskIsActive(status: DownloadStatus): boolean {
  return ["preparing", "downloading", "processing"].includes(status.stage);
}

export function taskDisplayName(status: DownloadStatus): string {
  return status.display_name || status.version || "";
}

export function taskHasFloatingEntry(status: DownloadStatus): boolean {
  // Completed records remain in the backend history. Only a running task or
  // an error needing review keeps the floating task entry on another page.
  return taskIsActive(status) || status.stage === "error";
}

/**
 * The task page owns an automatic return only while viewing the job that
 * opened it. Navigation releases that ownership; a later terminal poll must
 * not move a resource page or a different job. Reviewing an error acquires no
 * automatic return, and an already completed quick job never opens the page.
 */
export class TaskPageOwner {
  private task: string | null = null;

  open(status: DownloadStatus): boolean {
    this.task = taskIsActive(status) ? taskIdentity(status) : null;
    return taskHasFloatingEntry(status);
  }

  leave(): void {
    this.task = null;
  }

  takeCompletion(status: DownloadStatus): boolean {
    if (status.stage !== "complete" || this.task !== taskIdentity(status))
      return false;
    this.task = null;
    return true;
  }
}
