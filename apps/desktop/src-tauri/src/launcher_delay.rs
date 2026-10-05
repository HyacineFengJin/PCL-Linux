//! Optional diagnostic delay at the start of the asynchronous launch worker.
//! Never call this while holding admission, configuration or filesystem locks.
//! Cancellation remains responsive even at the maximum configured delay.
use std::{
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

/// True means preparation was cancelled, including an already-set stop flag.
pub fn preparation_delay(milliseconds: u16, cancelled: &AtomicBool) -> bool {
    let deadline = Instant::now() + Duration::from_millis(milliseconds.min(5000) as u64);
    loop {
        if cancelled.load(Ordering::SeqCst) {
            return true;
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return false;
        }
        std::thread::sleep(remaining.min(Duration::from_millis(10)));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn zero_delay_and_preexisting_cancel_do_not_wait() {
        let stopped = AtomicBool::new(false);
        assert!(!preparation_delay(0, &stopped));
        stopped.store(true, Ordering::SeqCst);
        let start = Instant::now();
        assert!(preparation_delay(5000, &stopped));
        assert!(start.elapsed() < Duration::from_millis(100));
    }
    #[test]
    fn cancel_interrupts_long_delay_instead_of_sleeping_full_duration() {
        let stopped = AtomicBool::new(false);
        std::thread::scope(|scope| {
            scope.spawn(|| {
                std::thread::sleep(Duration::from_millis(20));
                stopped.store(true, Ordering::SeqCst);
            });
            let start = Instant::now();
            assert!(preparation_delay(5000, &stopped));
            assert!(start.elapsed() < Duration::from_secs(1));
        });
    }
}
