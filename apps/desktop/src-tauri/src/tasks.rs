use serde::Serialize;
use serde_json::Value;
use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};

const HISTORY_LIMIT: usize = 64;
static NEXT_TASK_ID: AtomicU64 = AtomicU64::new(1);
type Listener = Arc<dyn Fn(TaskSnapshot) + Send + Sync>;

#[derive(Clone, Debug)]
pub struct TaskTarget {
    pub root_id: String,
    pub root_path: String,
    pub instance_id: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskKind {
    Install,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskStage {
    Preparing,
    Downloading,
    Processing,
    Complete,
    Error,
    Cancelled,
}

impl TaskStage {
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Complete | Self::Error | Self::Cancelled)
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Preparing => "preparing",
            Self::Downloading => "downloading",
            Self::Processing => "processing",
            Self::Complete => "complete",
            Self::Error => "error",
            Self::Cancelled => "cancelled",
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct TaskSnapshot {
    pub id: String,
    pub root_id: String,
    pub root_path: String,
    pub instance_id: Option<String>,
    pub kind: TaskKind,
    pub stage: TaskStage,
    pub phase: String,
    pub message: String,
    pub progress: f64,
    pub completed: u64,
    pub total: u64,
    pub bytes_done: u64,
    pub bytes_total: u64,
    pub network_bytes: u64,
    pub result: Option<Value>,
    pub error: Option<String>,
    pub can_cancel: bool,
    pub created_at: u64,
    pub finished_at: Option<u64>,
}

pub struct TaskProgress {
    pub stage: TaskStage,
    pub phase: String,
    pub message: String,
    pub completed: u64,
    pub total: u64,
    pub bytes_done: u64,
    pub bytes_total: u64,
    pub network_bytes: u64,
}

pub enum TaskOutcome {
    Complete {
        result: Option<Value>,
        message: String,
        // A post-install persistence warning does not invalidate the installed result.
        error: Option<String>,
    },
    Failed(String),
}

struct TaskRecord {
    snapshot: TaskSnapshot,
    cancel: Arc<AtomicBool>,
}

struct Inner {
    history: VecDeque<TaskRecord>,
    active_id: Option<String>,
    listener: Option<Listener>,
}

/// One admitted writer and a bounded, in-memory record of its finished tasks.
/// The worker owns its handle until it has stopped using the captured target.
pub struct Tasks {
    inner: Mutex<Inner>,
    history_limit: usize,
}

pub struct TaskHandle {
    tasks: Arc<Tasks>,
    id: String,
    cancel: Arc<AtomicBool>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

fn publish(listener: Option<Listener>, snapshot: TaskSnapshot) {
    if let Some(listener) = listener {
        // UI notification failures must not strand an admitted worker.
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| listener(snapshot)));
    }
}

impl Default for Tasks {
    fn default() -> Self {
        Self::new()
    }
}

impl Tasks {
    pub fn new() -> Self {
        Self::with_history_limit(HISTORY_LIMIT)
    }

    fn with_history_limit(history_limit: usize) -> Self {
        Self {
            inner: Mutex::new(Inner {
                history: VecDeque::new(),
                active_id: None,
                listener: None,
            }),
            history_limit: history_limit.max(1),
        }
    }

    pub fn set_listener(&self, listener: impl Fn(TaskSnapshot) + Send + Sync + 'static) {
        self.inner.lock().unwrap().listener = Some(Arc::new(listener));
    }

    pub fn list(&self) -> Vec<TaskSnapshot> {
        self.inner
            .lock()
            .unwrap()
            .history
            .iter()
            .rev()
            .map(|record| record.snapshot.clone())
            .collect()
    }

    pub fn snapshot(&self, id: &str) -> Option<TaskSnapshot> {
        self.inner
            .lock()
            .unwrap()
            .history
            .iter()
            .find(|record| record.snapshot.id == id)
            .map(|record| record.snapshot.clone())
    }

    pub fn active(&self) -> Option<TaskSnapshot> {
        let inner = self.inner.lock().unwrap();
        let id = inner.active_id.as_ref()?;
        inner
            .history
            .iter()
            .find(|record| &record.snapshot.id == id)
            .map(|record| record.snapshot.clone())
    }

    pub fn active_root_id(&self) -> Option<String> {
        self.active().map(|snapshot| snapshot.root_id)
    }

    pub fn uses_root(&self, root_id: &str) -> bool {
        self.active_root_id().as_deref() == Some(root_id)
    }

    pub fn admit(
        self: &Arc<Self>,
        target: TaskTarget,
        kind: TaskKind,
    ) -> Result<TaskHandle, String> {
        let (snapshot, cancel, listener) = {
            let mut inner = self.inner.lock().unwrap();
            if inner.active_id.is_some() {
                return Err("已有安装任务，请等待完成或取消".into());
            }
            let created_at = now_ms();
            let id = format!(
                "task-{created_at}-{}",
                NEXT_TASK_ID.fetch_add(1, Ordering::Relaxed)
            );
            let snapshot = TaskSnapshot {
                id: id.clone(),
                root_id: target.root_id,
                root_path: target.root_path,
                instance_id: target.instance_id,
                kind,
                stage: TaskStage::Preparing,
                phase: "metadata".into(),
                message: "正在获取版本信息…".into(),
                progress: 0.0,
                completed: 0,
                total: 0,
                bytes_done: 0,
                bytes_total: 0,
                network_bytes: 0,
                result: None,
                error: None,
                can_cancel: true,
                created_at,
                finished_at: None,
            };
            let cancel = Arc::new(AtomicBool::new(false));
            inner.history.push_back(TaskRecord {
                snapshot: snapshot.clone(),
                cancel: cancel.clone(),
            });
            inner.active_id = Some(id);
            self.trim(&mut inner);
            (snapshot, cancel, inner.listener.clone())
        };
        let handle = TaskHandle {
            tasks: self.clone(),
            id: snapshot.id.clone(),
            cancel,
        };
        publish(listener, snapshot);
        Ok(handle)
    }

    pub fn cancel(&self, id: &str) -> Result<TaskSnapshot, String> {
        let (snapshot, listener, changed) = {
            let mut inner = self.inner.lock().unwrap();
            let record = inner
                .history
                .iter_mut()
                .find(|record| record.snapshot.id == id)
                .ok_or("找不到此任务")?;
            let changed = record.snapshot.can_cancel && !record.snapshot.stage.is_terminal();
            if changed {
                record.cancel.store(true, Ordering::SeqCst);
                record.snapshot.can_cancel = false;
                record.snapshot.message = "正在取消安装…".into();
            }
            (record.snapshot.clone(), inner.listener.clone(), changed)
        };
        if changed {
            publish(listener, snapshot.clone());
        }
        Ok(snapshot)
    }

    fn trim(&self, inner: &mut Inner) {
        while inner.history.len() > self.history_limit {
            let Some(index) = inner
                .history
                .iter()
                .position(|record| Some(&record.snapshot.id) != inner.active_id.as_ref())
            else {
                break;
            };
            inner.history.remove(index);
        }
    }

    fn update(&self, id: &str, progress: TaskProgress) -> Option<TaskSnapshot> {
        if progress.stage.is_terminal() {
            return None;
        }
        let (snapshot, listener) = {
            let mut inner = self.inner.lock().unwrap();
            if inner.active_id.as_deref() != Some(id) {
                return None;
            }
            let record = inner
                .history
                .iter_mut()
                .find(|record| record.snapshot.id == id)?;
            let snapshot = &mut record.snapshot;
            snapshot.stage = progress.stage;
            snapshot.phase = progress.phase;
            if !record.cancel.load(Ordering::SeqCst) {
                snapshot.message = progress.message;
            }
            // Parallel file callbacks can arrive out of order. File completion and
            // real network transfer totals are cumulative; retry bytes may fall.
            snapshot.completed = snapshot.completed.max(progress.completed);
            snapshot.total = snapshot.total.max(progress.total);
            snapshot.bytes_done = progress.bytes_done;
            snapshot.bytes_total = snapshot.bytes_total.max(progress.bytes_total);
            snapshot.network_bytes = snapshot.network_bytes.max(progress.network_bytes);
            let ratio = if snapshot.bytes_total > 0 {
                snapshot.bytes_done as f64 / snapshot.bytes_total as f64
            } else if snapshot.total > 0 {
                snapshot.completed as f64 / snapshot.total as f64
            } else {
                0.0
            };
            snapshot.progress = snapshot.progress.max(ratio.clamp(0.0, 1.0));
            (snapshot.clone(), inner.listener.clone())
        };
        publish(listener, snapshot.clone());
        Some(snapshot)
    }

    fn begin_finishing(&self, id: &str) {
        let change = {
            let mut inner = self.inner.lock().unwrap();
            if inner.active_id.as_deref() != Some(id) {
                return;
            }
            let Some(record) = inner
                .history
                .iter_mut()
                .find(|record| record.snapshot.id == id)
            else {
                return;
            };
            record.snapshot.stage = TaskStage::Processing;
            record.snapshot.can_cancel = false;
            (record.snapshot.clone(), inner.listener.clone())
        };
        publish(change.1, change.0);
    }

    fn finish(&self, id: &str, outcome: TaskOutcome) -> Option<TaskSnapshot> {
        let (snapshot, listener) = {
            let mut inner = self.inner.lock().unwrap();
            if inner.active_id.as_deref() != Some(id) {
                return None;
            }
            let record = inner
                .history
                .iter_mut()
                .find(|record| record.snapshot.id == id)?;
            let snapshot = &mut record.snapshot;
            match outcome {
                TaskOutcome::Complete {
                    result,
                    message,
                    error,
                } => {
                    snapshot.stage = TaskStage::Complete;
                    snapshot.phase = "complete".into();
                    snapshot.message = message;
                    snapshot.progress = 1.0;
                    snapshot.result = result;
                    snapshot.error = error;
                }
                TaskOutcome::Failed(error) => {
                    let cancelled = record.cancel.load(Ordering::SeqCst);
                    snapshot.stage = if cancelled {
                        TaskStage::Cancelled
                    } else {
                        TaskStage::Error
                    };
                    snapshot.phase = snapshot.stage.as_str().into();
                    snapshot.message = if cancelled {
                        "安装已取消，已下载的完整文件可继续复用".into()
                    } else {
                        error.clone()
                    };
                    snapshot.error = if cancelled { None } else { Some(error) };
                }
            }
            snapshot.can_cancel = false;
            snapshot.finished_at = Some(now_ms().max(snapshot.created_at));
            let snapshot = snapshot.clone();
            inner.active_id = None;
            self.trim(&mut inner);
            (snapshot, inner.listener.clone())
        };
        publish(listener, snapshot.clone());
        Some(snapshot)
    }
}

impl TaskHandle {
    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn cancellation_token(&self) -> Arc<AtomicBool> {
        self.cancel.clone()
    }

    pub fn update(&self, progress: TaskProgress) -> Option<TaskSnapshot> {
        self.tasks.update(&self.id, progress)
    }

    pub fn begin_finishing(&self) {
        self.tasks.begin_finishing(&self.id);
    }

    pub fn finish(&self, outcome: TaskOutcome) -> Option<TaskSnapshot> {
        self.tasks.finish(&self.id, outcome)
    }

    pub fn publish(&self) {
        let state = {
            let inner = self.tasks.inner.lock().unwrap();
            inner
                .history
                .iter()
                .find(|record| record.snapshot.id == self.id)
                .map(|record| (record.snapshot.clone(), inner.listener.clone()))
        };
        if let Some((snapshot, listener)) = state {
            publish(listener, snapshot);
        }
    }
}

impl Drop for TaskHandle {
    fn drop(&mut self) {
        // Dropping the worker lease happens only after its work has stopped.
        self.tasks
            .finish(&self.id, TaskOutcome::Failed("任务意外退出，请重试".into()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{mpsc, Barrier};

    fn target(root: &str) -> TaskTarget {
        TaskTarget {
            root_id: root.into(),
            root_path: format!("{}/work/task-tests/{root}", env!("CARGO_MANIFEST_DIR")),
            instance_id: Some("fixture-version".into()),
        }
    }

    fn complete(task: &TaskHandle) {
        task.finish(TaskOutcome::Complete {
            result: Some(serde_json::json!({ "id": "fixture-version" })),
            message: "完成".into(),
            error: None,
        });
    }

    #[test]
    fn concurrent_admission_has_one_writer() {
        let tasks = Arc::new(Tasks::new());
        let barrier = Arc::new(Barrier::new(3));
        let (tx, rx) = mpsc::channel();
        let mut workers = Vec::new();
        for root in ["root-a", "root-b"] {
            let tasks = tasks.clone();
            let barrier = barrier.clone();
            let tx = tx.clone();
            workers.push(std::thread::spawn(move || {
                barrier.wait();
                tx.send(tasks.admit(target(root), TaskKind::Install))
                    .unwrap();
            }));
        }
        barrier.wait();
        let outcomes = [rx.recv().unwrap(), rx.recv().unwrap()];
        assert_eq!(outcomes.iter().filter(|outcome| outcome.is_ok()).count(), 1);
        for worker in workers {
            worker.join().unwrap();
        }
        assert!(tasks.active().is_some());
        drop(outcomes);
        assert!(tasks.active().is_none());
    }

    #[test]
    fn cancellation_keeps_writer_and_captured_scope_until_worker_finishes() {
        let tasks = Arc::new(Tasks::new());
        let task = tasks.admit(target("root-a"), TaskKind::Install).unwrap();
        let cancelled = tasks.cancel(task.id()).unwrap();
        assert!(!cancelled.can_cancel);
        assert!(task.cancellation_token().load(Ordering::SeqCst));
        assert!(tasks.uses_root("root-a"));
        assert!(!tasks.uses_root("root-b"));
        assert!(tasks.admit(target("root-b"), TaskKind::Install).is_err());
        assert_eq!(
            tasks.snapshot(task.id()).unwrap().root_path,
            target("root-a").root_path
        );
        task.finish(TaskOutcome::Failed("取消".into()));
        assert!(tasks.active().is_none());
        assert_eq!(
            tasks.snapshot(task.id()).unwrap().stage,
            TaskStage::Cancelled
        );
        assert!(tasks.admit(target("root-b"), TaskKind::Install).is_ok());
    }

    #[test]
    fn history_is_bounded_and_late_cancel_cannot_touch_new_task() {
        let tasks = Arc::new(Tasks::with_history_limit(2));
        let first = tasks.admit(target("root-a"), TaskKind::Install).unwrap();
        let first_id = first.id().to_owned();
        complete(&first);
        assert!(tasks.active().is_none());
        let second = tasks.admit(target("root-b"), TaskKind::Install).unwrap();
        assert_ne!(first.id(), second.id());
        let before = serde_json::to_value(tasks.snapshot(&first_id).unwrap()).unwrap();
        tasks.cancel(&first_id).unwrap();
        assert_eq!(
            before,
            serde_json::to_value(tasks.snapshot(&first_id).unwrap()).unwrap()
        );
        assert!(!second.cancellation_token().load(Ordering::SeqCst));
        complete(&second);
        let third = tasks.admit(target("root-c"), TaskKind::Install).unwrap();
        assert_eq!(tasks.list().len(), 2);
        assert!(tasks.snapshot(&first_id).is_none());
        assert_eq!(tasks.list()[0].id, third.id());
    }

    #[test]
    fn progress_and_network_bytes_are_monotonic_with_retry_counters() {
        let tasks = Arc::new(Tasks::new());
        let task = tasks.admit(target("root-a"), TaskKind::Install).unwrap();
        for (completed, bytes_done, network_bytes) in [(4, 80, 60), (3, 40, 50)] {
            task.update(TaskProgress {
                stage: TaskStage::Downloading,
                phase: "downloading".into(),
                message: "下载".into(),
                completed,
                total: 10,
                bytes_done,
                bytes_total: 100,
                network_bytes,
            });
        }
        let snapshot = tasks.snapshot(task.id()).unwrap();
        assert_eq!(snapshot.completed, 4);
        assert_eq!(snapshot.bytes_done, 40);
        assert_eq!(snapshot.network_bytes, 60);
        assert_eq!(snapshot.progress, 0.8);
        tasks.cancel(task.id()).unwrap();
        task.update(TaskProgress {
            stage: TaskStage::Processing,
            phase: "installing".into(),
            message: "安装".into(),
            completed: 10,
            total: 10,
            bytes_done: 100,
            bytes_total: 100,
            network_bytes: 70,
        });
        let snapshot = tasks.snapshot(task.id()).unwrap();
        assert_eq!(snapshot.stage, TaskStage::Processing);
        assert_eq!(snapshot.phase, "installing");
        assert_eq!(snapshot.message, "正在取消安装…");
        assert_eq!(snapshot.progress, 1.0);
    }

    #[test]
    fn completion_warning_keeps_result_and_publishes_without_locks() {
        let tasks = Arc::new(Tasks::new());
        let weak = Arc::downgrade(&tasks);
        let (tx, rx) = mpsc::channel();
        tasks.set_listener(move |snapshot| {
            let tasks = weak.upgrade().unwrap();
            assert!(tasks.snapshot(&snapshot.id).is_some());
            let _ = tasks.list();
            tx.send(snapshot.stage).unwrap();
        });
        let task = tasks.admit(target("root-a"), TaskKind::Install).unwrap();
        task.begin_finishing();
        tasks.cancel(task.id()).unwrap();
        assert!(!task.cancellation_token().load(Ordering::SeqCst));
        task.finish(TaskOutcome::Complete {
            result: Some(serde_json::json!({ "id": "fixture-version" })),
            message: "安装完成，但选择失败".into(),
            error: Some("保存失败".into()),
        });
        let snapshot = tasks.snapshot(task.id()).unwrap();
        assert_eq!(snapshot.stage, TaskStage::Complete);
        assert_eq!(snapshot.result.unwrap()["id"], "fixture-version");
        assert_eq!(snapshot.error.as_deref(), Some("保存失败"));
        assert!(snapshot.finished_at.unwrap() >= snapshot.created_at);
        assert!(tasks.active().is_none());
        assert_eq!(
            rx.try_iter().collect::<Vec<_>>(),
            vec![
                TaskStage::Preparing,
                TaskStage::Processing,
                TaskStage::Complete
            ]
        );
    }
}
