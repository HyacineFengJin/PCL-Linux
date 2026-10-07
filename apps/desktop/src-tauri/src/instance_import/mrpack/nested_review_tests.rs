//! Independent fault cases for one-layer launcher archives. All source, roots
//! and anonymous staging descriptors live beneath the project review scratch.
use super::*;
use serde_json::json;
use std::{
    fs,
    io::{Cursor, Read, Seek, SeekFrom, Write},
    os::{fd::AsRawFd, unix::fs::MetadataExt},
    sync::atomic::{AtomicBool, AtomicUsize, Ordering},
};
use zip::{write::SimpleFileOptions, ZipArchive, ZipWriter};
struct Fixture {
    _directory: crate::integration_tests::Fixture,
    base: PathBuf,
    root: PathBuf,
    source: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let work = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../work/nested-pack-2026-10-06/review/fixtures");
        fs::create_dir_all(&work).unwrap();
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let base = work.join(format!(
            "archive-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&base).unwrap();
        let base = base.canonicalize().unwrap();
        let directory = crate::integration_tests::Fixture(base.clone());
        let root = base.join("root");
        fs::create_dir(&root).unwrap();
        Self {
            source: base.join("selected.zip"),
            root,
            base,
            _directory: directory,
        }
    }
    fn save(&self, bytes: &[u8]) {
        fs::write(&self.source, bytes).unwrap();
    }
    fn prepare(
        &self,
        cancel: &AtomicBool,
        allocate: impl FnOnce(u64) -> Result<File>,
    ) -> Result<CheckedPack> {
        prepare_checked_with_stage(&self.root, &self.source, "Nested", None, cancel, allocate)
    }
    fn anonymous(&self) -> File {
        Dir::open(&self.base).unwrap().anonymous().unwrap()
    }
    fn assert_untouched(&self, source: &[u8]) {
        assert_eq!(fs::read(&self.source).unwrap(), source);
        assert_eq!(fs::read_dir(&self.root).unwrap().count(), 0);
    }
}
fn zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    for (path, bytes) in entries {
        writer.start_file(*path, options).unwrap();
        writer.write_all(bytes).unwrap();
    }
    writer.finish().unwrap().into_inner()
}
fn inner() -> Vec<u8> {
    let index = serde_json::to_vec(&json!({"formatVersion":1,"game":"minecraft","versionId":"1","name":"Inner Facts","files":[],"dependencies":{"minecraft":"1.21.1"}})).unwrap();
    zip(&[
        (INDEX, &index),
        ("overrides/config/actual.cfg", b"inner configuration"),
    ])
}
fn corrupt_body(mut bytes: Vec<u8>, entry: &str) -> Vec<u8> {
    let offset = {
        let mut archive = ZipArchive::new(Cursor::new(&bytes)).unwrap();
        let entry = archive.by_name(entry).unwrap();
        assert!(entry.size() > 0);
        entry.data_start() as usize
    };
    bytes[offset] ^= 0x10;
    bytes
}
struct AnonymousIdentity {
    device: u64,
    inode: u64,
    target: PathBuf,
}
impl AnonymousIdentity {
    fn of(file: &File) -> Self {
        let metadata = file.metadata().unwrap();
        assert_eq!(metadata.nlink(), 0);
        Self {
            device: metadata.dev(),
            inode: metadata.ino(),
            target: fs::read_link(format!("/proc/self/fd/{}", file.as_raw_fd())).unwrap(),
        }
    }
    fn assert_closed(&self) {
        // A parallel fixture can reuse a deleted inode. Match the unique
        // anonymous target as well, while checking every FD to catch aliases.
        for entry in fs::read_dir("/proc/self/fd").unwrap() {
            let path = entry.unwrap().path();
            let target = match fs::read_link(&path) {
                Ok(target) => target,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => panic!("cannot inspect fixture descriptor: {error}"),
            };
            if target != self.target {
                continue;
            }
            match fs::metadata(&path) {
                Ok(metadata) => assert!(
                    metadata.dev() != self.device || metadata.ino() != self.inode,
                    "failed preparation retained its anonymous inner FD"
                ),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => panic!("cannot inspect fixture inode: {error}"),
            }
        }
    }
}
#[test]
fn review_nested_fd_probe_detects_retained_alias() {
    let fixture = Fixture::new();
    let file = fixture.anonymous();
    let identity = AnonymousIdentity::of(&file);
    let alias = file.try_clone().unwrap();
    drop(file);
    assert!(std::panic::catch_unwind(|| identity.assert_closed()).is_err());
    drop(alias);
    identity.assert_closed();
}
#[test]
fn review_nested_global_candidate_ambiguity_is_rejected_before_payload_allocation() {
    let inner = inner();
    let manifest = br#"{"minecraft":{"version":"1.21.1","modLoaders":[]},"manifestType":"minecraftModpack","manifestVersion":1,"name":"Competing Pack","version":"1","files":[],"overrides":"overrides"}"#;
    for entries in [
        vec![
            ("modpack.zip", inner.as_slice()),
            (".hmcl/modpack/modpack.mrpack", inner.as_slice()),
        ],
        vec![
            ("first/modpack.zip", inner.as_slice()),
            ("second/modpack.mrpack", inner.as_slice()),
        ],
        vec![
            ("modpack.zip", inner.as_slice()),
            ("manifest.json", manifest.as_slice()),
        ],
        vec![("deep/wrapper/modpack.zip", inner.as_slice())],
    ] {
        let fixture = Fixture::new();
        let source = zip(&entries);
        fixture.save(&source);
        let calls = AtomicUsize::new(0);
        assert!(fixture
            .prepare(&AtomicBool::new(false), |_| {
                calls.fetch_add(1, Ordering::Relaxed);
                Ok(fixture.anonymous())
            })
            .is_err());
        assert_eq!(calls.load(Ordering::Relaxed), 0);
        fixture.assert_untouched(&source);
    }
}
#[test]
fn review_nested_crc_faults_close_payload_and_validate_ignored_launcher_bytes() {
    let good = inner();
    let bad_inner = corrupt_body(good.clone(), "overrides/config/actual.cfg");
    for source in [
        corrupt_body(
            zip(&[
                ("modpack.zip", &good),
                ("launcher.exe", b"ignored executable"),
            ]),
            "launcher.exe",
        ),
        corrupt_body(zip(&[("modpack.zip", &good)]), "modpack.zip"),
        zip(&[("modpack.zip", &bad_inner)]),
    ] {
        let fixture = Fixture::new();
        fixture.save(&source);
        let held_key = std::cell::RefCell::new(None);
        let error = match fixture.prepare(&AtomicBool::new(false), |_| {
            let file = fixture.anonymous();
            *held_key.borrow_mut() = Some(AnonymousIdentity::of(&file));
            Ok(file)
        }) {
            Ok(_) => panic!("CRC-corrupted archive produced authority"),
            Err(error) => error,
        };
        assert!(error.contains("CRC") || error.contains("解压"), "{error}");
        if let Some(identity) = held_key.borrow().as_ref() {
            identity.assert_closed();
        }
        fixture.assert_untouched(&source);
    }
}
#[test]
fn review_nested_early_disk_refusal_wins_before_inner_decode_and_cancel_drops_fd() {
    let fixture = Fixture::new();
    let malformed = vec![b'x'; 128 * 1024];
    let source = zip(&[("modpack.zip", &malformed)]);
    fixture.save(&source);
    let calls = AtomicUsize::new(0);
    let error = match fixture.prepare(&AtomicBool::new(false), |size| {
        assert_eq!(size, malformed.len() as u64);
        calls.fetch_add(1, Ordering::Relaxed);
        Err("fixture early disk admission refused".into())
    }) {
        Ok(_) => panic!("refused allocation succeeded"),
        Err(error) => error,
    };
    assert_eq!(error, "fixture early disk admission refused");
    assert_eq!(calls.load(Ordering::Relaxed), 1);
    fixture.assert_untouched(&source);
    let source = zip(&[("modpack.zip", &inner())]);
    fixture.save(&source);
    let cancel = AtomicBool::new(false);
    let held_key = std::cell::RefCell::new(None);
    assert!(fixture
        .prepare(&cancel, |_| {
            let file = fixture.anonymous();
            *held_key.borrow_mut() = Some(AnonymousIdentity::of(&file));
            cancel.store(true, Ordering::Release);
            Ok(file)
        })
        .is_err());
    held_key.borrow().as_ref().unwrap().assert_closed();
    fixture.assert_untouched(&source);
}
#[test]
fn review_nested_destination_must_be_empty_anonymous_regular_fd() {
    for anonymous in [false, true] {
        let fixture = Fixture::new();
        let source = zip(&[("modpack.zip", &inner())]);
        fixture.save(&source);
        let mut file = if anonymous {
            fixture.anonymous()
        } else {
            File::create(fixture.base.join("named-payload")).unwrap()
        };
        if anonymous {
            file.write_all(b"not empty").unwrap();
        }
        assert!(fixture
            .prepare(&AtomicBool::new(false), |_| Ok(file))
            .is_err());
        fixture.assert_untouched(&source);
        if !anonymous {
            assert_eq!(
                fs::metadata(fixture.base.join("named-payload"))
                    .unwrap()
                    .len(),
                0
            );
        }
    }
}
#[test]
fn review_nested_second_launcher_layer_is_rejected_without_recursive_allocation() {
    let nested = zip(&[(".hmcl/modpack/modpack.zip", &inner())]);
    let source = zip(&[("modpack.zip", &nested)]);
    let fixture = Fixture::new();
    fixture.save(&source);
    let calls = AtomicUsize::new(0);
    let held_key = std::cell::RefCell::new(None);
    assert!(fixture
        .prepare(&AtomicBool::new(false), |_| {
            calls.fetch_add(1, Ordering::Relaxed);
            let file = fixture.anonymous();
            *held_key.borrow_mut() = Some(AnonymousIdentity::of(&file));
            Ok(file)
        })
        .is_err());
    assert_eq!(calls.load(Ordering::Relaxed), 1);
    held_key.borrow().as_ref().unwrap().assert_closed();
    fixture.assert_untouched(&source);
}
#[test]
fn review_nested_outer_authority_and_inner_fd_are_both_checked_after_prepare() {
    for mutate_inner in [true, false] {
        let fixture = Fixture::new();
        let content = inner();
        let source = zip(&[
            (".hmcl/modpack/modpack.zip", &content),
            ("launcher_accounts.json", b"ignored account"),
        ]);
        fixture.save(&source);
        let checked = fixture
            .prepare(&AtomicBool::new(false), |_| Ok(fixture.anonymous()))
            .unwrap();
        assert_eq!(checked.retained_source_fds(), 2);
        assert_eq!(checked.retained_inner_bytes(), content.len() as u64);
        assert!(checked.plan.binding.source == super::Source::Local(fixture.source.clone()));
        assert_eq!(checked.plan.pack_name, "Inner Facts");
        let mut payload = checked.content_file().unwrap();
        let mut actual = Vec::new();
        payload.seek(SeekFrom::Start(0)).unwrap();
        payload.read_to_end(&mut actual).unwrap();
        assert_eq!(actual, content);
        checked.recheck_source(&AtomicBool::new(false)).unwrap();
        checked.recheck_source_stamp().unwrap();
        if mutate_inner {
            // Rewriting identical bytes still changes the native held snapshot;
            // mutation must not disappear because the outer stays unchanged.
            payload.seek(SeekFrom::Start(0)).unwrap();
            payload.write_all(&content).unwrap();
            payload.sync_all().unwrap();
            assert_eq!(fs::read(&fixture.source).unwrap(), source);
        } else {
            let replacement = fixture.base.join("replacement.zip");
            fs::write(&replacement, &source).unwrap();
            fs::rename(replacement, &fixture.source).unwrap();
        }
        assert!(checked.recheck_source_stamp().is_err());
        assert!(checked.recheck_source(&AtomicBool::new(false)).is_err());
        assert_eq!(fs::read_dir(&fixture.root).unwrap().count(), 0);
    }
}
