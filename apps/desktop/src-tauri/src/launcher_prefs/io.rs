//! Preferences retain their original document contract while sharing the fixed
//! launcher CAS engine with resource favorites. Transfer bounds remain 64 KiB.
pub(super) use crate::launcher_document::{
    persist, prepare_directory, snapshot, verify, Directory, Snapshot,
};
pub(super) const MAX_BYTES: usize = 64 * 1024;
