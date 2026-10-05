//! Pure session/FD fixtures and actual loopback HTTP. Folder dialogs, file
//! managers, real roots/accounts/settings and process policy globals are unused.
use super::*;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Seek, SeekFrom, Write},
    net::TcpListener,
    os::unix::fs::{symlink, PermissionsExt},
    sync::{
        atomic::{AtomicU64, AtomicUsize},
        Mutex,
    },
    thread,
    time::{Duration, Instant},
};
static NEXT: AtomicU64 = AtomicU64::new(0);
fn run<F: std::future::Future>(future: F) -> F::Output {
    tauri::async_runtime::block_on(future)
}
fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
struct Fixture {
    path: PathBuf,
    folder: PathBuf,
    decoy: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../work/launcher-local-actions-2026-10-05/tests/toolbox-download")
            .join(format!(
                "{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
        fs::create_dir_all(path.join("chosen")).unwrap();
        fs::create_dir_all(path.join("decoy-game")).unwrap();
        let path = path.canonicalize().unwrap();
        let decoy = path.join("decoy-game");
        fs::write(decoy.join("retained"), b"untouched").unwrap();
        Self {
            folder: path.join("chosen"),
            decoy,
            path,
        }
    }
    fn session(&self) -> (DownloadSession, DirectoryView) {
        let session = DownloadSession::default();
        let (generation, _) = session.begin_choose();
        let view = session
            .adopt_directory(generation, self.folder.clone())
            .unwrap();
        (session, view)
    }
    fn pending(&self, url: &str) -> PreparedDownload {
        let (session, directory) = self.session();
        let preview = session
            .prepare(
                PrepareRequest {
                    directory_token: directory.token,
                    url: url.into(),
                    file_name: "sample.bin".into(),
                },
                "prefs-fixture".into(),
            )
            .unwrap();
        session
            .start_guard(&preview.token, "prefs-fixture")
            .unwrap()
            .take()
    }
    fn target(&self) -> PathBuf {
        self.folder.join("sample.bin")
    }
    fn assert_empty(&self) {
        assert_eq!(fs::read_dir(&self.folder).unwrap().count(), 0);
        self.assert_decoy();
    }
    fn assert_decoy(&self) {
        assert_eq!(fs::read(self.decoy.join("retained")).unwrap(), b"untouched");
        assert_eq!(fs::read_dir(&self.decoy).unwrap().count(), 1);
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}
#[derive(Clone)]
struct Reply {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
    chunked: bool,
    declared: Option<usize>,
    headers_delay: Duration,
    body_delay: Duration,
}
impl Reply {
    fn body(bytes: &[u8]) -> Self {
        Self {
            status: 200,
            headers: Vec::new(),
            body: bytes.to_vec(),
            chunked: false,
            declared: None,
            headers_delay: Duration::ZERO,
            body_delay: Duration::ZERO,
        }
    }
    fn redirect(location: &str) -> Self {
        let mut reply = Self::body(&[]);
        reply.status = 302;
        reply.headers.push(("Location".into(), location.into()));
        reply
    }
}
struct Server {
    url: String,
    stop: Arc<AtomicBool>,
    requests: Arc<Mutex<Vec<String>>>,
    worker: Option<thread::JoinHandle<()>>,
}
impl Server {
    fn new(reply: impl Fn(&str) -> Reply + Send + Sync + 'static) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let stop = Arc::new(AtomicBool::new(false));
        let requests = Arc::new(Mutex::new(Vec::new()));
        let signal = stop.clone();
        let seen = requests.clone();
        let reply = Arc::new(reply);
        let worker = thread::spawn(move || {
            let mut workers = Vec::new();
            while !signal.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok((mut socket, _)) => {
                        let seen = seen.clone();
                        let reply = reply.clone();
                        workers.push(thread::spawn(move || {
                            socket
                                .set_read_timeout(Some(Duration::from_secs(2)))
                                .unwrap();
                            socket
                                .set_write_timeout(Some(Duration::from_secs(2)))
                                .unwrap();
                            let mut request = [0; 8192];
                            let count = socket.read(&mut request).unwrap_or(0);
                            let target = String::from_utf8_lossy(&request[..count])
                                .lines()
                                .next()
                                .unwrap_or("")
                                .split_whitespace()
                                .nth(1)
                                .unwrap_or("")
                                .to_owned();
                            seen.lock().unwrap().push(target.clone());
                            let reply = reply(&target);
                            thread::sleep(reply.headers_delay);
                            let _ = write!(
                                socket,
                                "HTTP/1.1 {} Fixture\r\nConnection: close\r\n",
                                reply.status
                            );
                            for (name, value) in &reply.headers {
                                let _ = write!(socket, "{name}: {value}\r\n");
                            }
                            if reply.chunked {
                                let _ = write!(socket, "Transfer-Encoding: chunked\r\n\r\n");
                            } else {
                                let _ = write!(
                                    socket,
                                    "Content-Length: {}\r\n\r\n",
                                    reply.declared.unwrap_or(reply.body.len())
                                );
                            }
                            thread::sleep(reply.body_delay);
                            if reply.chunked {
                                let _ = write!(socket, "{:x}\r\n", reply.body.len());
                                let _ = socket.write_all(&reply.body);
                                let _ = socket.write_all(b"\r\n0\r\n\r\n");
                            } else {
                                let _ = socket.write_all(&reply.body);
                            }
                        }));
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(2))
                    }
                    Err(error) => panic!("fixture accept: {error}"),
                }
            }
            for worker in workers {
                worker.join().unwrap();
            }
        });
        Self {
            url,
            stop,
            requests,
            worker: Some(worker),
        }
    }
    fn path(&self, path: &str) -> String {
        format!("{}{path}", self.url)
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        self.worker.take().unwrap().join().unwrap();
    }
}
fn scheduler(rate: u32) -> Arc<DownloadScheduler> {
    DownloadScheduler::new(pcl_network::DownloadPolicy {
        total_rate_limit_mib_per_second: rate,
        max_concurrent_transfers: 1,
        ..Default::default()
    })
    .unwrap()
}
fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .no_gzip()
        .no_brotli()
        .no_deflate()
        .no_zstd()
        .build()
        .unwrap()
}
fn transfer(
    fixture: &Fixture,
    url: &str,
    cancel: &AtomicBool,
    scheduler: &DownloadScheduler,
    limits: transfer::TransferLimits,
    report: impl Fn(DownloadProgress),
    gate: CommitGate<'_>,
) -> Result<DownloadResult> {
    run(download_with_client(
        fixture.pending(url),
        &client(),
        scheduler,
        cancel,
        report,
        gate,
        limits,
    ))
}
#[test]
fn tokens_bind_real_selected_directory_generation_revision_expiry_and_single_use() {
    let fixture = Fixture::new();
    let session = DownloadSession::default();
    let (first, _) = session.begin_choose();
    let (second, _) = session.begin_choose();
    assert!(session
        .adopt_directory(first, fixture.folder.clone())
        .is_err());
    let directory = session
        .adopt_directory(second, fixture.folder.clone())
        .unwrap();
    let request = PrepareRequest {
        directory_token: directory.token.clone(),
        url: "https://example.invalid/file?signature=private-secret".into(),
        file_name: "sample.bin".into(),
    };
    let preview = session
        .prepare(request.clone(), "prefs-old".into())
        .unwrap();
    let exported = serde_json::to_string(&preview).unwrap();
    assert!(!exported.contains("private-secret"));
    assert_eq!(preview.target, fixture.target().display().to_string());
    assert!(session.start_guard(&preview.token, "prefs-new").is_err());
    {
        let held = session.start_guard(&preview.token, "prefs-old").unwrap();
        assert_eq!(held.directory(), fixture.folder);
    }
    let _prepared = session
        .start_guard(&preview.token, "prefs-old")
        .unwrap()
        .take();
    assert!(session.start_guard(&preview.token, "prefs-old").is_err());
    let preview = session
        .prepare(request.clone(), "prefs-old".into())
        .unwrap();
    session.expire_pending();
    assert!(session.start_guard(&preview.token, "prefs-old").is_err());
    let preview = session
        .prepare(request.clone(), "prefs-old".into())
        .unwrap();
    let mut bad = request;
    bad.url = "file:///etc/passwd".into();
    assert!(session.prepare(bad, "prefs-old".into()).is_err());
    assert!(session.start_guard(&preview.token, "prefs-old").is_err());
    let (generation, _) = session.begin_choose();
    fs::create_dir(fixture.path.join("new-folder")).unwrap();
    session
        .adopt_directory(generation, fixture.path.join("new-folder"))
        .unwrap();
    assert!(session.held_directory(&directory.token).is_err());
    fixture.assert_empty();
}
#[test]
fn unsafe_inputs_and_redirect_downgrades_are_rejected_without_echoing_secrets() {
    for url in [
        "file:///etc/passwd",
        "data:text/plain,private-secret",
        "https://user:private-secret@example.invalid/x",
        "https://example.invalid/x#private-secret",
        "http://example.invalid/x\\other",
        "http://example.invalid/a b",
    ] {
        let error = authority::validate_url(url).unwrap_err();
        assert!(!error.contains("private-secret"));
    }
    for name in [
        "",
        ".",
        "..",
        "../escape",
        "sub/file",
        "sub\\file",
        "a\nb",
        "example:bad",
        "a?private-secret",
        " spaced ",
    ] {
        assert!(files::validate_name(name).is_err());
    }
    assert!(files::validate_name(&"a".repeat(241)).is_err());
    assert!(
        authority::validate_url(&format!("https://example.invalid/{}", "a".repeat(8192))).is_err()
    );
    assert!(serde_json::from_value::<PrepareRequest>(serde_json::json!({"directoryToken":"token","url":"https://example.invalid/x","fileName":"sample.bin","target":"/unselected"})).is_err());
    let secure = authority::validate_url("https://example.invalid/a").unwrap();
    assert!(transfer::redirect_url(&secure, "http://example.invalid/b").is_err());
    assert!(
        transfer::redirect_url(&secure, "https://user:private-secret@example.invalid/b").is_err()
    );
    assert!(transfer::redirect_url(&secure, "/b?signature=private-secret").is_ok());
}
#[test]
fn actual_unknown_length_redirected_stream_has_computed_hash_and_chosen_destination() {
    let fixture = Fixture::new();
    let server = Server::new(|path| {
        if path.starts_with("/redirect") {
            Reply::redirect("/file?signature=private-secret")
        } else {
            let mut reply = Reply::body(b"actual downloaded bytes");
            reply.chunked = true;
            reply
        }
    });
    let cancel = AtomicBool::new(false);
    let scheduler = scheduler(0);
    let rows = Mutex::new(Vec::new());
    let gates = AtomicUsize::new(0);
    let mut gate = || {
        gates.fetch_add(1, Ordering::Relaxed);
        assert!(!fixture.target().exists());
        Ok(())
    };
    let result = transfer(
        &fixture,
        &server.path("/redirect?initial=private-secret"),
        &cancel,
        &scheduler,
        Default::default(),
        |row| rows.lock().unwrap().push(row),
        &mut gate,
    )
    .unwrap();
    assert_eq!(result.sha256, sha(b"actual downloaded bytes"));
    assert_eq!(result.size, 23);
    assert_eq!(
        fs::read(fixture.target()).unwrap(),
        b"actual downloaded bytes"
    );
    assert!(result.warning.is_none());
    assert_eq!(gates.load(Ordering::Relaxed), 1);
    assert_eq!(
        fs::metadata(fixture.target()).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert_eq!(fs::read_dir(&fixture.folder).unwrap().count(), 1);
    fixture.assert_decoy();
    let requests = server.requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert!(requests[1].contains("signature=private-secret"));
    let rows = rows.lock().unwrap();
    assert!(rows
        .iter()
        .any(|row| row.phase == "downloading" && row.bytes_total == 0));
    assert_eq!(rows.last().unwrap().phase, "complete");
    assert!(rows
        .windows(2)
        .all(|pair| pair[0].network_bytes <= pair[1].network_bytes
            && pair[0].bytes_done <= pair[1].bytes_done));
}
#[test]
fn actual_http_loop_and_invalid_redirect_stop_with_anonymous_cleanup() {
    for location in [
        "/loop?token=private-secret",
        "file:///etc/passwd",
        "http://user:private-secret@example.invalid/file",
    ] {
        let fixture = Fixture::new();
        let location = location.to_owned();
        let server = Server::new(move |_| Reply::redirect(&location));
        let cancel = AtomicBool::new(false);
        let scheduler = scheduler(0);
        let mut gate = || panic!("no invalid redirect may reach commit");
        let error = transfer(
            &fixture,
            &server.path("/loop"),
            &cancel,
            &scheduler,
            Default::default(),
            |_| {},
            &mut gate,
        )
        .unwrap_err();
        assert!(!error.contains("private-secret"));
        fixture.assert_empty();
        assert_eq!(scheduler.status().active_transfers, 0);
        assert!(server.requests.lock().unwrap().len() <= 6);
    }
}

#[test]
fn unsuccessful_http_status_and_missing_redirect_do_not_publish_or_echo_address() {
    for status in [404, 500, 302] {
        let fixture = Fixture::new();
        let server = Server::new(move |_| {
            let mut reply = Reply::body(b"remote failure body private-secret");
            reply.status = status;
            reply
        });
        let cancel = AtomicBool::new(false);
        let scheduler = scheduler(0);
        let mut gate = || panic!("unsuccessful responses cannot reach commit");
        let error = transfer(
            &fixture,
            &server.path("/file?signature=private-secret"),
            &cancel,
            &scheduler,
            Default::default(),
            |_| {},
            &mut gate,
        )
        .unwrap_err();
        assert!(!error.contains("private-secret"));
        if status == 302 {
            assert!(error.contains("重定向地址"));
        } else {
            assert!(error.contains(&format!("HTTP {status}")));
        }
        assert_eq!(server.requests.lock().unwrap().len(), 1);
        assert_eq!(scheduler.status().active_transfers, 0);
        fixture.assert_empty();
    }
}
#[test]
fn partial_encoded_and_content_range_responses_are_never_saved_as_full_files() {
    for case in 0..4 {
        let fixture = Fixture::new();
        let server = Server::new(move |_| {
            let mut reply = Reply::body(b"good");
            match case {
                0 => reply.status = 206,
                1 => reply
                    .headers
                    .push(("Content-Encoding".into(), "gzip".into())),
                2 => reply
                    .headers
                    .push(("Content-Range".into(), "bytes 0-3/9".into())),
                _ => {
                    reply
                        .headers
                        .push(("Content-Encoding".into(), "identity".into()));
                    reply.headers.push(("Content-Encoding".into(), "br".into()));
                }
            }
            reply
        });
        let cancel = AtomicBool::new(false);
        let scheduler = scheduler(0);
        let mut gate = || panic!("partial/encoded responses must not commit");
        let error = transfer(
            &fixture,
            &server.path("/file?token=private-secret"),
            &cancel,
            &scheduler,
            Default::default(),
            |_| {},
            &mut gate,
        )
        .unwrap_err();
        assert!(error.contains(if case == 0 || case == 2 {
            "部分内容"
        } else {
            "编码内容"
        }));
        assert!(!error.contains("private-secret"));
        fixture.assert_empty();
    }
}
#[test]
fn declared_oversize_stream_oversize_and_truncated_http_bodies_leave_no_partial() {
    for case in 0..3 {
        let fixture = Fixture::new();
        let server = Server::new(move |_| {
            let mut reply = Reply::body(if case == 2 {
                b"good"
            } else {
                b"too-large-body"
            });
            if case == 0 {
                reply.declared = Some(1024);
            } else if case == 1 {
                reply.chunked = true;
            } else {
                reply.declared = Some(10);
            }
            reply
        });
        let cancel = AtomicBool::new(false);
        let scheduler = scheduler(0);
        let limits = transfer::TransferLimits {
            maximum_bytes: if case == 2 { 64 } else { 8 },
            ..Default::default()
        };
        let mut gate = || panic!("bad response must not commit");
        let error = transfer(
            &fixture,
            &server.path("/file?signature=private-secret"),
            &cancel,
            &scheduler,
            limits,
            |_| {},
            &mut gate,
        )
        .unwrap_err();
        assert!(!error.contains("private-secret"));
        fixture.assert_empty();
        assert_eq!(scheduler.status().active_transfers, 0);
    }
}
#[test]
fn actual_transfer_shares_scheduler_rate_and_submission_keeps_original_selection() {
    let fixture = Fixture::new();
    let body = vec![7; 1024 * 1024];
    let payload = body.clone();
    let server = Server::new(move |_| Reply::body(&payload));
    let cancel = AtomicBool::new(false);
    let scheduler = scheduler(1);
    let (session, directory) = fixture.session();
    let preview = session
        .prepare(
            PrepareRequest {
                directory_token: directory.token,
                url: server.path("/file"),
                file_name: "sample.bin".into(),
            },
            "prefs-fixture".into(),
        )
        .unwrap();
    let prepared = session
        .start_guard(&preview.token, "prefs-fixture")
        .unwrap()
        .take();
    let (generation, _) = session.begin_choose();
    let other = fixture.path.join("other-selected");
    fs::create_dir(&other).unwrap();
    session.adopt_directory(generation, other.clone()).unwrap();
    let mut gate = || Ok(());
    let start = Instant::now();
    let network = Arc::new(
        ClientFactory::new(pcl_network::Policy {
            proxy: pcl_network::ProxyPolicy::None,
            dns: pcl_network::DnsPolicy::System,
        })
        .unwrap(),
    );
    let result = run(download(
        prepared,
        network,
        scheduler.clone(),
        &cancel,
        |_| {},
        &mut gate,
    ))
    .unwrap();
    assert!(start.elapsed() >= Duration::from_millis(995));
    assert_eq!(result.sha256, sha(&body));
    assert_eq!(fs::read(fixture.target()).unwrap(), body);
    assert_eq!(fs::read_dir(other).unwrap().count(), 0);
    assert_eq!(scheduler.status().paced_payload_bytes, 1024 * 1024);
    fixture.assert_decoy();
}
#[test]
fn queued_headers_body_and_rate_waits_cancel_before_commit_and_release_admission() {
    for case in 0..4 {
        let fixture = Fixture::new();
        let server = Server::new(move |_| {
            let body = if case == 3 {
                vec![7; 1024 * 1024]
            } else {
                b"good".to_vec()
            };
            let mut reply = Reply::body(&body);
            if case == 1 {
                reply.headers_delay = Duration::from_millis(600);
            } else if case == 2 {
                reply.body_delay = Duration::from_millis(600);
            }
            reply
        });
        let cancel = Arc::new(AtomicBool::new(false));
        let scheduler = scheduler(if case == 3 { 1 } else { 0 });
        let blocker = if case == 0 {
            Some(scheduler.acquire_blocking(&AtomicBool::new(false)).unwrap())
        } else {
            None
        };
        let signal = cancel.clone();
        let trigger = thread::spawn(move || {
            thread::sleep(Duration::from_millis(80));
            signal.store(true, Ordering::Release)
        });
        let start = Instant::now();
        let mut gate = || panic!("cancelled transfer must not commit");
        let error = transfer(
            &fixture,
            &server.path("/file"),
            &cancel,
            &scheduler,
            Default::default(),
            |_| {},
            &mut gate,
        )
        .unwrap_err();
        assert_eq!(error, CANCELLED);
        assert!(start.elapsed() < Duration::from_millis(400));
        trigger.join().unwrap();
        drop(blocker);
        assert_eq!(scheduler.status().active_transfers, 0);
        assert_eq!(scheduler.status().queued_transfers, 0);
        if case == 0 {
            assert_eq!(server.requests.lock().unwrap().len(), 0);
        }
        fixture.assert_empty();
    }
}
#[test]
fn bounded_header_idle_and_queue_total_deadlines_are_errors_with_no_named_file() {
    for case in 0..3 {
        let fixture = Fixture::new();
        let server = Server::new(move |_| {
            let mut reply = Reply::body(b"good");
            if case == 0 {
                reply.headers_delay = Duration::from_millis(600);
            } else if case == 1 {
                reply.body_delay = Duration::from_millis(600);
            }
            reply
        });
        let cancel = AtomicBool::new(false);
        let scheduler = scheduler(0);
        let blocker = if case == 2 {
            Some(scheduler.acquire_blocking(&AtomicBool::new(false)).unwrap())
        } else {
            None
        };
        let limits = transfer::TransferLimits {
            header_timeout: Duration::from_millis(70),
            read_timeout: Duration::from_millis(70),
            total_timeout: Duration::from_millis(150),
            ..Default::default()
        };
        let mut gate = || panic!("timed-out transfer must not commit");
        let start = Instant::now();
        let error = transfer(
            &fixture,
            &server.path("/file?token=private-secret"),
            &cancel,
            &scheduler,
            limits,
            |_| {},
            &mut gate,
        )
        .unwrap_err();
        assert!(error.contains("时间限制"));
        assert_ne!(error, CANCELLED);
        assert!(!error.contains("private-secret"));
        assert!(start.elapsed() < Duration::from_millis(400));
        drop(blocker);
        fixture.assert_empty();
    }
}
#[test]
fn replaced_directory_collisions_rejected_gate_and_commit_cancel_preserve_existing_data() {
    for case in 0..4 {
        let fixture = Fixture::new();
        let server = Server::new(|_| Reply::body(b"good"));
        let cancel = AtomicBool::new(false);
        let scheduler = scheduler(0);
        let mut gate = || match case {
            0 => {
                fs::write(fixture.target(), b"external").unwrap();
                Ok(())
            }
            1 => {
                fs::rename(&fixture.folder, fixture.path.join("original-folder")).unwrap();
                fs::create_dir(&fixture.folder).unwrap();
                fs::write(fixture.folder.join("external"), b"retained").unwrap();
                Ok(())
            }
            2 => Err("task commit gate rejected".into()),
            _ => {
                cancel.store(true, Ordering::Release);
                Ok(())
            }
        };
        let error = transfer(
            &fixture,
            &server.path("/file"),
            &cancel,
            &scheduler,
            Default::default(),
            |_| {},
            &mut gate,
        )
        .unwrap_err();
        match case {
            0 => assert_eq!(fs::read(fixture.target()).unwrap(), b"external"),
            1 => {
                assert_eq!(
                    fs::read(fixture.folder.join("external")).unwrap(),
                    b"retained"
                );
                assert_eq!(
                    fs::read_dir(fixture.path.join("original-folder"))
                        .unwrap()
                        .count(),
                    0
                );
            }
            2 => {
                assert_eq!(error, "task commit gate rejected");
                fixture.assert_empty();
            }
            _ => {
                assert_eq!(error, CANCELLED);
                fixture.assert_empty();
            }
        }
        fixture.assert_decoy();
    }
}
#[test]
fn symlink_hardlink_replacement_and_changed_stage_are_preserved_without_overwrite() {
    let fixture = Fixture::new();
    let original = fixture.path.join("original");
    fs::write(&original, b"original").unwrap();
    let (session, directory) = fixture.session();
    let request = PrepareRequest {
        directory_token: directory.token.clone(),
        url: "https://example.invalid/file".into(),
        file_name: "sample.bin".into(),
    };
    symlink(&original, fixture.target()).unwrap();
    assert!(session.prepare(request.clone(), "prefs".into()).is_err());
    fs::remove_file(fixture.target()).unwrap();
    fs::hard_link(&original, fixture.target()).unwrap();
    assert!(session.prepare(request.clone(), "prefs".into()).is_err());
    fs::remove_file(fixture.target()).unwrap();
    let selected = files::Directory::open(&fixture.folder).unwrap();
    let mut file = selected.anonymous().unwrap();
    file.write_all(b"good").unwrap();
    let mut external = file.try_clone().unwrap();
    let verified =
        files::verify_anonymous(file, 4, &sha(b"good"), &AtomicBool::new(false)).unwrap();
    external.seek(SeekFrom::Start(0)).unwrap();
    external.write_all(b"bad!").unwrap();
    assert!(selected
        .publish("sample.bin", &verified)
        .unwrap_err()
        .contains("最终复核后变化"));
    fixture.assert_empty();
    fs::rename(&fixture.folder, fixture.path.join("prior")).unwrap();
    fs::create_dir(&fixture.folder).unwrap();
    assert!(session.held_directory(&directory.token).is_err());
    assert!(session.prepare(request, "prefs".into()).is_err());
    assert_eq!(fs::read(original).unwrap(), b"original");
}
#[test]
fn published_warning_and_empty_file_have_precise_success_semantics() {
    let fixture = Fixture::new();
    let directory = files::Directory::open(&fixture.folder).unwrap();
    let mut file = directory.anonymous().unwrap();
    file.write_all(b"good").unwrap();
    let verified =
        files::verify_anonymous(file, 4, &sha(b"good"), &AtomicBool::new(false)).unwrap();
    let warning = directory
        .publish_with_failed_sync("sample.bin", &verified)
        .unwrap()
        .unwrap();
    assert!(warning.contains("文件已保存"));
    assert_eq!(fs::read(fixture.target()).unwrap(), b"good");
    fs::remove_file(fixture.target()).unwrap();
    let server = Server::new(|_| Reply::body(&[]));
    let cancel = AtomicBool::new(false);
    let scheduler = scheduler(0);
    let mut gate = || Ok(());
    let result = transfer(
        &fixture,
        &server.path("/empty"),
        &cancel,
        &scheduler,
        Default::default(),
        |row| {
            if row.phase == "complete" {
                cancel.store(true, Ordering::Release)
            }
        },
        &mut gate,
    )
    .unwrap();
    assert_eq!(result.size, 0);
    assert_eq!(result.sha256, sha(&[]));
    assert!(result.warning.is_none());
    assert_eq!(fs::metadata(fixture.target()).unwrap().len(), 0);
    fixture.assert_decoy();
}
#[test]
fn detected_stream_size_error_is_not_masked_by_late_cancellation() {
    let fixture = Fixture::new();
    let server = Server::new(|_| {
        let mut reply = Reply::body(b"too-large-body");
        reply.chunked = true;
        reply
    });
    let cancel = AtomicBool::new(false);
    let scheduler = scheduler(0);
    let limits = transfer::TransferLimits {
        maximum_bytes: 8,
        ..Default::default()
    };
    let mut gate = || panic!("oversize response must not commit");
    let error = transfer(
        &fixture,
        &server.path("/file"),
        &cancel,
        &scheduler,
        limits,
        |row| {
            if row.network_bytes > 8 {
                cancel.store(true, Ordering::Release)
            }
        },
        &mut gate,
    )
    .unwrap_err();
    assert!(error.contains("超过限制"));
    assert_ne!(error, CANCELLED);
    fixture.assert_empty();
}
