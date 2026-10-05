//! Turn reservation is separate from task admission. Earlier overlapping jobs
//! retain FIFO priority, including a cancelled job whose worker is cleaning up.
//! Unrelated scopes may pass a blocked queue head. Reservation lasts through
//! worker cleanup; neither cancellation nor a UI observer releases it.

use super::{Inner, TaskScope, TaskSnapshot, TaskStage};
use std::sync::atomic::Ordering;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Turn {
    Queued,
    Running,
    Terminal,
}

pub(super) fn can_start(inner: &Inner, scope: &TaskScope, limit: usize) -> bool {
    let running = inner
        .history
        .iter()
        .filter(|record| record.turn == Turn::Running)
        .count();
    running < limit
        && !inner
            .history
            .iter()
            .any(|record| !record.snapshot.stage.is_terminal() && record.scope.conflicts(scope))
}

pub(super) fn promote(inner: &mut Inner, limit: usize) -> Vec<TaskSnapshot> {
    let mut running: Vec<_> = inner
        .history
        .iter()
        .filter(|record| record.turn == Turn::Running)
        .map(|record| record.scope.clone())
        .collect();
    let mut earlier = Vec::<TaskScope>::new();
    let mut changes = Vec::new();
    for record in &mut inner.history {
        if record.turn != Turn::Queued {
            continue;
        }
        let available = !record.cancel.load(Ordering::SeqCst)
            && running.len() < limit
            && !running
                .iter()
                .chain(&earlier)
                .any(|scope| scope.conflicts(&record.scope));
        if available {
            record.turn = Turn::Running;
            record.snapshot.stage = TaskStage::Preparing;
            record.snapshot.phase = record.initial_phase.clone();
            record.snapshot.message = record.initial_message.clone();
            running.push(record.scope.clone());
            changes.push(record.snapshot.clone());
        } else {
            earlier.push(record.scope.clone());
        }
    }
    for _ in &changes {
        inner.changed();
    }
    changes
}
