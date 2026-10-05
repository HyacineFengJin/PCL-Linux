use super::{
    announcements::{self, AnnouncementScope, AnnouncementState, AnnouncementStore},
    clipboard::parse_modrinth_link,
    provider::{BoxFuture, Failure, Headers, Provider, Response, MAX_BYTES},
};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
struct Fake {
    calls: AtomicUsize,
    body: Vec<u8>,
    status: u16,
    remaining: Option<u64>,
    next: bool,
    fail: bool,
}
impl Fake {
    fn new(body: Vec<u8>) -> Self {
        Self {
            calls: AtomicUsize::new(0),
            body,
            status: 200,
            remaining: None,
            next: false,
            fail: false,
        }
    }
}
impl Provider for Fake {
    fn fetch(&self) -> BoxFuture<'_, Result<Response, Failure>> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move {
            if self.fail {
                return Err(Failure::Network);
            }
            Ok(Response {
                status: self.status,
                headers: Headers {
                    remaining: self.remaining,
                    has_next: self.next,
                    ..Default::default()
                },
                body: self.body.clone(),
            })
        })
    }
}
fn network() -> Arc<pcl_network::ClientFactory> {
    Arc::new(
        pcl_network::ClientFactory::new(pcl_network::Policy {
            proxy: pcl_network::ProxyPolicy::None,
            ..Default::default()
        })
        .unwrap(),
    )
}
fn release(id: u64, prerelease: bool) -> serde_json::Value {
    serde_json::json!({"id":id,"tag_name":format!("v{id}.0"),
    "name":format!("Generic release {id}"),"body":"Generic plain release notes","draft":false,"prerelease":prerelease,
    "published_at":"2026-10-01T12:00:00Z","html_url":"https://untrusted.example/path"})
}
#[test]
fn canonical_modrinth_types_and_ids_are_preserved() {
    for kind in ["mod", "resourcepack", "shader", "modpack"] {
        let url = format!("https://modrinth.com/{kind}/Example_42-name");
        let link = parse_modrinth_link(&format!(" \n{url}\n ")).unwrap();
        assert_eq!(link.kind, kind);
        assert_eq!(link.project_id_or_slug, "Example_42-name");
        assert_eq!(link.url, url);
    }
    assert_eq!(
        parse_modrinth_link("https://modrinth.com/mod/Ab12Cd34")
            .unwrap()
            .project_id_or_slug,
        "Ab12Cd34"
    );
}
#[test]
fn clipboard_rejects_authority_and_path_tricks_without_echoing_source() {
    for url in [
        "http://modrinth.com/mod/generic",
        "https://user:private@modrinth.com/mod/generic",
        "https://modrinth.com:443/mod/generic",
        "https://modrinth.com:444/mod/generic",
        "https://modrinth.com.evil/mod/generic",
        "https://modrinth.com./mod/generic",
        "https://modrinth.com/mod/generic?redirect=https://private.example",
        "https://modrinth.com/mod/generic#private",
        "https://modrinth.com/mod/%2e%2e/modpack/generic",
        "https://modrinth.com/mod/%67eneric",
        "https://modrinth.com/mod/generic/version/version-id",
        "https://modrinth.com/mod/generic/",
        "https://modrinth.com/mod/generic\\other",
        "https://modrinth.com/collection/generic",
        "prefix https://modrinth.com/mod/generic",
    ] {
        let error = parse_modrinth_link(url).unwrap_err();
        assert!(!error.contains(url));
    }
    assert!(parse_modrinth_link(&"private".repeat(1024)).is_err());
}
#[tokio::test]
async fn none_does_not_call_provider_or_expose_cached_announcements() {
    let store = AnnouncementStore::default();
    let network = network();
    let provider = Fake::new(serde_json::to_vec(&vec![release(1, false)]).unwrap());
    let none = store
        .read_with(AnnouncementScope::None, false, network.clone(), &provider)
        .await;
    assert_eq!(none.state, AnnouncementState::Disabled);
    assert_eq!(provider.calls.load(Ordering::SeqCst), 0);
    store
        .read_with(AnnouncementScope::All, false, network.clone(), &provider)
        .await;
    let none = store
        .read_with(AnnouncementScope::None, true, network, &provider)
        .await;
    assert!(none.items.is_empty());
    assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
}
#[tokio::test]
async fn stable_filter_cache_refresh_and_network_identity_use_actual_provider() {
    let store = AnnouncementStore::default();
    let network = network();
    let provider =
        Fake::new(serde_json::to_vec(&vec![release(1, false), release(2, true)]).unwrap());
    let all = store
        .read_with(AnnouncementScope::All, false, network.clone(), &provider)
        .await;
    assert_eq!(all.items.len(), 2);
    assert!(!all.cached);
    assert!(all.items.iter().all(|item| item
        .url
        .starts_with("https://github.com/HyacineFengJin/PCL-Linux/releases/tag/")));
    let important = store
        .read_with(
            AnnouncementScope::Important,
            false,
            network.clone(),
            &provider,
        )
        .await;
    assert_eq!(important.items.len(), 1);
    assert!(important.cached);
    assert!(!important.items[0].prerelease);
    assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
    store
        .read_with(AnnouncementScope::All, true, network, &provider)
        .await;
    assert_eq!(provider.calls.load(Ordering::SeqCst), 2);
    store
        .read_with(AnnouncementScope::All, false, self::network(), &provider)
        .await;
    assert_eq!(provider.calls.load(Ordering::SeqCst), 3);
}
#[tokio::test]
async fn empty_window_and_filtered_partial_window_report_their_actual_scope() {
    let store = AnnouncementStore::default();
    let network = network();
    let provider = Fake::new(b"[]".to_vec());
    let empty = store
        .read_with(AnnouncementScope::All, false, network.clone(), &provider)
        .await;
    assert_eq!(empty.state, AnnouncementState::Empty);
    let mut provider = Fake::new(serde_json::to_vec(&vec![release(2, true)]).unwrap());
    provider.next = true;
    let empty = store
        .read_with(AnnouncementScope::Important, true, network, &provider)
        .await;
    assert_eq!(empty.state, AnnouncementState::Empty);
    assert!(empty.truncated);
    assert!(empty.message.unwrap().contains("较早公告未读取"));
}
#[tokio::test]
async fn rate_limit_is_distinct_from_forbidden_and_upstream_errors_never_echo_body() {
    let store = AnnouncementStore::default();
    let network = network();
    let mut provider = Fake::new(b"private raw upstream credentials".to_vec());
    provider.status = 403;
    provider.remaining = Some(0);
    let rate = store
        .read_with(AnnouncementScope::All, false, network.clone(), &provider)
        .await;
    assert_eq!(rate.state, AnnouncementState::RateLimited);
    assert!(!rate.message.unwrap().contains("private"));
    provider.remaining = Some(10);
    let unavailable = store
        .read_with(AnnouncementScope::All, true, network.clone(), &provider)
        .await;
    assert_eq!(unavailable.state, AnnouncementState::Unavailable);
    provider.status = 429;
    assert_eq!(
        store
            .read_with(AnnouncementScope::All, true, network, &provider)
            .await
            .state,
        AnnouncementState::RateLimited
    );
}
#[tokio::test]
async fn response_and_collection_bounds_refuse_instead_of_inventing_empty_feed() {
    let store = AnnouncementStore::default();
    let network = network();
    for body in [
        vec![b'x'; MAX_BYTES + 1],
        b"private malformed response".to_vec(),
        serde_json::to_vec(&(1..=31).map(|id| release(id, false)).collect::<Vec<_>>()).unwrap(),
        serde_json::to_vec(&vec![release(1, false), release(1, false)]).unwrap(),
    ] {
        let provider = Fake::new(body);
        assert_eq!(
            store
                .read_with(AnnouncementScope::All, true, network.clone(), &provider)
                .await
                .state,
            AnnouncementState::Unavailable
        );
    }
}
#[tokio::test]
async fn html_remains_literal_text_and_drafts_or_foreign_links_never_escape() {
    let store = AnnouncementStore::default();
    let network = network();
    let mut visible = release(1, false);
    visible["body"] = serde_json::json!("<script>untrusted()</script><img src=file:///private>");
    let mut draft = release(2, false);
    draft["draft"] = serde_json::json!(true);
    draft["body"] = serde_json::json!("unpublished private text");
    let provider = Fake::new(serde_json::to_vec(&vec![visible, draft]).unwrap());
    let view = store
        .read_with(AnnouncementScope::All, false, network, &provider)
        .await;
    assert_eq!(view.items.len(), 1);
    assert!(view.items[0].text.contains("<script>"));
    let dto = serde_json::to_string(&view).unwrap();
    assert!(!dto.contains("unpublished private text"));
    assert!(!dto.contains("untrusted.example"));
}
#[tokio::test]
async fn unicode_title_and_total_plain_text_are_bounded_without_cutting_utf8() {
    let store = AnnouncementStore::default();
    let network = network();
    let mut rows = Vec::new();
    for id in 1..=30 {
        let mut row = release(id, false);
        row["name"] = serde_json::json!("名".repeat(400));
        row["body"] = serde_json::json!("文".repeat(8000));
        rows.push(row);
    }
    let provider = Fake::new(serde_json::to_vec(&rows).unwrap());
    let view = store
        .read_with(AnnouncementScope::All, false, network, &provider)
        .await;
    assert_eq!(view.items.len(), 30);
    assert!(view.truncated);
    assert!(view
        .items
        .iter()
        .all(|item| item.title.len() <= 512 && item.text.len() <= 16 * 1024));
    assert!(view.items.iter().map(|item| item.text.len()).sum::<usize>() <= 256 * 1024);
}
#[tokio::test]
async fn network_failure_reports_unavailable_and_is_cached_briefly() {
    let store = AnnouncementStore::default();
    let network = network();
    let mut provider = Fake::new(vec![]);
    provider.fail = true;
    let failed = store
        .read_with(AnnouncementScope::All, false, network.clone(), &provider)
        .await;
    assert_eq!(failed.state, AnnouncementState::Unavailable);
    let failed = store
        .read_with(AnnouncementScope::All, false, network, &provider)
        .await;
    assert!(failed.cached);
    assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
}
#[test]
fn retry_deadline_is_bounded_and_relative_header_takes_precedence() {
    let response = Response {
        status: 429,
        headers: Headers {
            retry_seconds: Some(5),
            reset_at: Some(u64::MAX),
            ..Default::default()
        },
        body: vec![],
    };
    let view = announcements::normalize(response);
    let fetched = view.fetched_at.unwrap();
    assert_eq!(view.retry_at, Some(fetched + 5));
    let response = Response {
        status: 429,
        headers: Headers {
            retry_seconds: Some(u64::MAX),
            reset_at: Some(u64::MAX),
            ..Default::default()
        },
        body: vec![],
    };
    assert!(announcements::normalize(response).retry_at.is_none());
}
