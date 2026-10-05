import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { Api } from "./types";
import { t } from "./i18n";
import {
  emptyTaskView,
  type DownloadStatus,
  type DownloadTaskView,
} from "./taskTypes";
import {
  adoptTaskView,
  taskIdentity,
  taskIsActive,
  taskIsTerminal,
  validTaskView,
} from "./taskLifecycle";
import {
  createLauncherClosingSource,
  type LauncherClosingSource,
} from "./useLauncherMinecraftNotices";

/** One application owner reads the scheduler, regardless of the browsed root.
 * Physical reads stay serial across API/lifetime replacement; a wake requested
 * during an older read is serviced after it finishes. Task events carry no
 * authority. Submission and cancellation callers await a snapshot started after
 * their wake, so an earlier poll cannot claim their new task/page ownership. */
export function useDownloadTasks({
  api,
  native,
  onTerminal,
  subscribeClosing,
}: {
  api: Api;
  native: boolean;
  onTerminal?: (status: DownloadStatus) => void;
  subscribeClosing?: LauncherClosingSource;
}) {
  const [view, setView] = useState<DownloadTaskView>(emptyTaskView),
    [error, setError] = useState(""),
    [isClosing, setClosing] = useState(false);
  const binding = useRef({ api, native, subscribeClosing });
  if (
    binding.current.api !== api ||
    binding.current.native !== native ||
    binding.current.subscribeClosing !== subscribeClosing
  )
    binding.current = { api, native, subscribeClosing };
  const owner = binding.current;
  const snapshot = useRef<DownloadTaskView>(emptyTaskView),
    snapshotOwner = useRef<object | null>(null);
  const physical = useRef<symbol | null>(null),
    wake = useRef<(() => void) | null>(null);
  const request = useRef<(() => Promise<DownloadTaskView | null>) | null>(null);
  const submitted = useRef(new Set<string>()),
    observed = useRef(new Set<string>()),
    terminal = useRef(new Set<string>());
  const callbacks = useRef(onTerminal);
  callbacks.current = onTerminal;
  const closeSource = useRef<LauncherClosingSource | null>(null);
  if (!closeSource.current) closeSource.current = createLauncherClosingSource();
  const refresh = useCallback(
    () => request.current?.() ?? Promise.resolve(null),
    [],
  );
  const track = useCallback((id: string) => {
    if (id) submitted.current.add(id);
  }, []);
  const acceptStatus = useCallback((status: DownloadStatus) => {
    if (snapshotOwner.current !== binding.current || !status.task_id) return;
    const old = snapshot.current.tasks.find(
      (task) => task.task_id === status.task_id,
    );
    if (!old || (taskIsTerminal(old) && !taskIsTerminal(status))) return;
    const next = {
      ...snapshot.current,
      tasks: snapshot.current.tasks.map((task) =>
        task.task_id === status.task_id ? status : task,
      ),
    };
    snapshot.current = next;
    setView(next);
    if (taskIsTerminal(status) && !terminal.current.has(status.task_id)) {
      terminal.current.add(status.task_id);
      callbacks.current?.(status);
    }
    void request.current?.();
  }, []);
  useEffect(() => {
    let disposed = false,
      closing = false,
      generation = 0,
      demand = 0;
    const waiters: {
      ticket: number;
      resolve: (view: DownloadTaskView | null) => void;
    }[] = [];
    snapshot.current = emptyTaskView;
    snapshotOwner.current = owner;
    submitted.current.clear();
    observed.current.clear();
    terminal.current.clear();
    setView(emptyTaskView);
    setError("");
    setClosing(false);
    const current = () => !disposed && binding.current === owner && !closing;
    function settle(ticket: number, value: DownloadTaskView | null) {
      for (let i = waiters.length - 1; i >= 0; i--)
        if (waiters[i].ticket <= ticket) waiters.splice(i, 1)[0].resolve(value);
    }
    async function run() {
      if (!current() || physical.current) return;
      const token = Symbol(),
        ticket = demand,
        epoch = generation;
      physical.current = token;
      let adopted: DownloadTaskView | null = null;
      try {
        const candidate = await api<unknown>("download_tasks");
        if (!current() || epoch !== generation) return;
        if (!validTaskView(candidate)) throw Error(t("task.invalidSnapshot"));
        const next = adoptTaskView(snapshot.current, candidate);
        snapshot.current = next;
        setView(next);
        setError("");
        adopted = next;
        for (const task of next.tasks) {
          const id = taskIdentity(task);
          if (taskIsActive(task)) observed.current.add(id);
          if (taskIsTerminal(task) && !terminal.current.has(id)) {
            terminal.current.add(id);
            callbacks.current?.(task);
          }
        }
        // Keep retained IDs bounded independently of backend history trimming.
        const retained = new Set(next.tasks.map(taskIdentity));
        for (const ids of [
          submitted.current,
          observed.current,
          terminal.current,
        ])
          if (ids.size > 512)
            for (const id of ids) if (!retained.has(id)) ids.delete(id);
      } catch (cause) {
        if (current() && epoch === generation) setError(String(cause));
      } finally {
        settle(ticket, adopted);
        if (physical.current === token) physical.current = null;
        if (current() && demand > ticket) void run();
        else if (wake.current !== wakeLatest) wake.current?.();
      }
    }
    function wakeLatest() {
      demand++;
      void run();
    }
    const refreshLatest = () =>
      new Promise<DownloadTaskView | null>((resolve) => {
        if (!current()) {
          resolve(null);
          return;
        }
        waiters.push({ ticket: ++demand, resolve });
        void run();
      });
    wake.current = wakeLatest;
    request.current = refreshLatest;
    wakeLatest();
    const timer = window.setInterval(wakeLatest, 1000);
    let unlistenTask: (() => void) | undefined,
      unlistenClose: (() => void) | undefined;
    if (native) {
      void listen("task_changed", wakeLatest)
        .then((stop) => {
          if (disposed) stop();
          else unlistenTask = stop;
        })
        .catch(() => {});
      void (subscribeClosing || closeSource.current!)((value) => {
        if (disposed || binding.current !== owner || closing === value) return;
        closing = value;
        generation++;
        setClosing(value);
        if (closing) settle(Infinity, null);
        else wakeLatest();
      })
        .then((stop) => {
          if (disposed) stop();
          else unlistenClose = stop;
        })
        .catch(() => {});
    }
    return () => {
      disposed = true;
      generation++;
      window.clearInterval(timer);
      unlistenTask?.();
      unlistenClose?.();
      settle(Infinity, null);
      if (wake.current === wakeLatest) wake.current = null;
      if (request.current === refreshLatest) request.current = null;
    };
  }, [owner]);
  return {
    view: snapshotOwner.current === owner ? view : emptyTaskView,
    error,
    closing: isClosing,
    refresh,
    track,
    acceptStatus,
    snapshot,
    owner,
  };
}
