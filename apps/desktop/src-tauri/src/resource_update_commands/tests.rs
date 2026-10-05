use super::*;

#[test]
fn dependency_failure_retains_traffic_and_error_after_cancel() {
    let tasks = Arc::new(tasks::Tasks::new());
    let handle = tasks
        .admit(
            tasks::TaskTarget {
                root_id: "fixture-root".into(),
                root_path: "/fixture".into(),
                instance_id: Some("ExampleGame".into()),
            },
            tasks::TaskKind::ResourceUpdate,
        )
        .unwrap();
    let id = handle.id().to_owned();
    transfer_progress(
        &handle,
        modrinth_install::DownloadProgress {
            phase: "metadata".into(),
            message: "checked".into(),
            completed: 0,
            total: 0,
            bytes_done: 0,
            bytes_total: 0,
            network_bytes: 4096,
        },
    );
    tasks.cancel(&id).unwrap();
    finish(
        handle,
        Err("Pinned installed dependency prevents replacement".into()),
        "complete",
    );
    let result = tasks.wait_terminal(&id).unwrap();
    assert_eq!(result.stage, tasks::TaskStage::Error);
    assert_eq!(result.network_bytes, 4096);
    assert!(result
        .error
        .unwrap()
        .contains("Pinned installed dependency"));
    assert!(tasks.active().is_none());
}

#[test]
fn accepted_cancel_before_restore_gate_keeps_admission_until_cleanup() {
    let tasks = Arc::new(tasks::Tasks::new());
    let handle = tasks
        .admit(
            tasks::TaskTarget {
                root_id: "fixture-root".into(),
                root_path: "/fixture".into(),
                instance_id: Some("ExampleGame".into()),
            },
            tasks::TaskKind::ResourceUpdateRestore,
        )
        .unwrap();
    let id = handle.id().to_owned();
    tasks.cancel(&id).unwrap();
    handle.begin_finishing();
    assert!(handle.cancellation_token().load(Ordering::SeqCst));
    assert!(tasks.active().is_some());
    finish(handle, Err(modrinth_install::CANCELLED.into()), "complete");
    let result = tasks.wait_terminal(&id).unwrap();
    assert_eq!(result.stage, tasks::TaskStage::Cancelled);
    assert!(result.error.is_none());
    assert!(result.message.contains("恢复记录已保留"));
    assert!(tasks.active().is_none());
}
