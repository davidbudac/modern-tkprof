//! Assistant API keys. A key the user chose to remember is kept in the OS keychain (service: the
//! app identifier, account `assist:<provider id>`, secret `{"endpoint", "key"}`), bound to the
//! endpoint it was typed for (the provider's kind and base URL). Rust reads the open prompt from
//! the engine (`GET /engine/prompts/{id}`) and answers an `apikey` prompt itself only when its
//! endpoint is the one the key was kept for (`POST /engine/prompts/{id}` with the token it holds),
//! so a stored key never enters the webview and never goes to another endpoint under the same id.
//! Without a keychain (Linux without a Secret Service, access denied) a remembered key is kept in
//! this process's memory until the app quits.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::engine::EngineManager;

const ANSWER_TIMEOUT: Duration = Duration::from_secs(5);

/// Where remembered keys live: the OS keychain, or a stand-in in tests.
pub trait Vault: Send + Sync {
    fn get(&self, account: &str) -> Result<Option<String>, VaultError>;
    fn set(&self, account: &str, secret: &str) -> Result<(), VaultError>;
    fn delete(&self, account: &str) -> Result<(), VaultError>;
}

#[derive(Debug)]
pub enum VaultError {
    /// no keychain to use: none on this system, locked, or access denied
    Unavailable(String),
    Failed(String),
}

impl std::fmt::Display for VaultError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            VaultError::Unavailable(e) => write!(f, "no keychain: {e}"),
            VaultError::Failed(e) => write!(f, "keychain: {e}"),
        }
    }
}

/// The OS keychain: Keychain Services, the Windows Credential Manager, the Secret Service.
pub struct Keychain {
    service: String,
}

impl Keychain {
    pub fn new(service: impl Into<String>) -> Self {
        Keychain {
            service: service.into(),
        }
    }

    fn entry(&self, account: &str) -> Result<keyring::Entry, VaultError> {
        keyring::Entry::new(&self.service, account).map_err(vault_error)
    }
}

fn vault_error(e: keyring::Error) -> VaultError {
    match e {
        keyring::Error::NoDefaultStore
        | keyring::Error::NoStorageAccess(_)
        | keyring::Error::PlatformFailure(_) => VaultError::Unavailable(e.to_string()),
        e => VaultError::Failed(e.to_string()),
    }
}

impl Vault for Keychain {
    fn get(&self, account: &str) -> Result<Option<String>, VaultError> {
        match self.entry(account)?.get_password() {
            Ok(k) => Ok(Some(k)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(vault_error(e)),
        }
    }

    fn set(&self, account: &str, secret: &str) -> Result<(), VaultError> {
        self.entry(account)?
            .set_password(secret)
            .map_err(vault_error)
    }

    fn delete(&self, account: &str) -> Result<(), VaultError> {
        match self.entry(account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(vault_error(e)),
        }
    }
}

/// A remembered key, or none.
#[derive(Debug, PartialEq)]
pub enum Stored {
    Key(String),
    /// `keychain` false: there is no keychain to remember one in
    Missing {
        keychain: bool,
    },
}

/// Where a typed key was kept besides the engine's memory.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kept {
    Keychain,
    /// in memory until the app quits: the keychain failed
    Session,
    /// not remembered: only the engine holds it, until it stops
    Engine,
}

/// A remembered key and the endpoint it answers for; the keychain secret as JSON.
#[derive(Clone, Serialize, Deserialize)]
struct Bound {
    endpoint: String,
    key: String,
}

impl Bound {
    /// The key when it was kept for `endpoint`; a secret of another shape answers for none.
    fn parse(secret: &str, endpoint: &str) -> Option<String> {
        serde_json::from_str::<Bound>(secret)
            .ok()
            .filter(|b| b.endpoint == endpoint && !b.key.is_empty())
            .map(|b| b.key)
    }
}

/// The remembered keys by provider id, each bound to an endpoint.
pub struct Secrets {
    vault: Box<dyn Vault>,
    /// keys remembered while the vault failed, for this run only
    session: Mutex<HashMap<String, Bound>>,
}

fn account(provider: &str) -> String {
    format!("assist:{provider}")
}

impl Secrets {
    pub fn new(vault: Box<dyn Vault>) -> Self {
        Secrets {
            vault,
            session: Mutex::default(),
        }
    }

    /// The key remembered for `provider` at `endpoint`; one kept for another endpoint is missing.
    pub fn find(&self, provider: &str, endpoint: &str) -> Stored {
        if let Some(b) = self.session.lock().unwrap().get(provider) {
            if b.endpoint == endpoint {
                return Stored::Key(b.key.clone());
            }
        }
        match self.vault.get(&account(provider)) {
            Ok(Some(secret)) => match Bound::parse(&secret, endpoint) {
                Some(k) => Stored::Key(k),
                None => Stored::Missing { keychain: true },
            },
            Ok(None) => Stored::Missing { keychain: true },
            Err(e @ VaultError::Unavailable(_)) => {
                log::warn!("assistant key of {provider}: {e}");
                Stored::Missing { keychain: false }
            }
            Err(e) => {
                log::warn!("assistant key of {provider}: {e}");
                Stored::Missing { keychain: true }
            }
        }
    }

    pub fn keep(&self, provider: &str, endpoint: &str, key: &str, remember: bool) -> Kept {
        if !remember {
            return Kept::Engine;
        }
        let bound = Bound {
            endpoint: endpoint.to_string(),
            key: key.to_string(),
        };
        let secret = serde_json::to_string(&bound).expect("two strings serialize");
        match self.vault.set(&account(provider), &secret) {
            Ok(()) => {
                self.session.lock().unwrap().remove(provider);
                Kept::Keychain
            }
            Err(e) => {
                log::warn!("assistant key of {provider}: {e}; kept for this session only");
                self.session
                    .lock()
                    .unwrap()
                    .insert(provider.to_string(), bound);
                Kept::Session
            }
        }
    }

    pub fn forget(&self, provider: &str) -> Result<(), String> {
        self.session.lock().unwrap().remove(provider);
        match self.vault.delete(&account(provider)) {
            Ok(()) | Err(VaultError::Unavailable(_)) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

/// A prompt or provider id as the engine makes them: it goes into a URL path and an account name.
fn check_id(what: &str, id: &str) -> Result<(), String> {
    let ok = !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b));
    if ok {
        Ok(())
    } else {
        Err(format!("{what}: not an id: {id:?}"))
    }
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .proxy(None)
        .http_status_as_error(false)
        .timeout_global(Some(ANSWER_TIMEOUT))
        .build()
        .into()
}

/// What Rust reads of an open prompt (`PromptEvent`).
#[derive(Debug, Deserialize, PartialEq)]
struct OpenPrompt {
    kind: String,
    connection: String,
    #[serde(default)]
    endpoint: String,
}

/// `GET /engine/prompts/{id}`: the open prompt as the engine raised it, straight from the engine.
fn get_prompt(addr: &str, token: &str, prompt_id: &str) -> Result<OpenPrompt, String> {
    let mut r = agent()
        .get(format!("http://{addr}/engine/prompts/{prompt_id}"))
        .header("Authorization", format!("Bearer {token}"))
        .call()
        .map_err(|e| format!("read the key prompt: {e}"))?;
    match r.status().as_u16() {
        200 => {}
        404 => return Err("the key prompt is gone (its turn ended)".into()),
        s => return Err(format!("read the key prompt: HTTP {s}")),
    }
    let body = r
        .body_mut()
        .read_to_string()
        .map_err(|e| format!("read the key prompt: {e}"))?;
    serde_json::from_str(&body).map_err(|e| format!("read the key prompt: {e}"))
}

/// The endpoint of the open `apikey` prompt `prompt_id` of `provider`.
async fn prompt_endpoint(
    engine: &EngineManager,
    prompt_id: &str,
    provider: &str,
) -> Result<String, String> {
    let (addr, token) = engine.endpoint().await.ok_or("the engine is not running")?;
    let id = prompt_id.to_string();
    let p = blocking(move || get_prompt(&addr, &token, &id)).await??;
    endpoint_of(p, provider)
}

fn endpoint_of(p: OpenPrompt, provider: &str) -> Result<String, String> {
    if p.kind != "apikey" || p.connection != provider {
        return Err(format!(
            "the prompt is not the key prompt of {provider} (kind {}, connection {})",
            p.kind, p.connection
        ));
    }
    Ok(p.endpoint)
}

/// `POST /engine/prompts/{id}` with `{"answer": key}`, straight to the engine (never a proxy).
fn post_answer(addr: &str, token: &str, prompt_id: &str, key: &str) -> Result<(), String> {
    let agent = agent();
    let body = serde_json::json!({ "answer": key }).to_string();
    let r = agent
        .post(format!("http://{addr}/engine/prompts/{prompt_id}"))
        .header("Authorization", format!("Bearer {token}"))
        .content_type("application/json")
        .send(body)
        .map_err(|e| format!("answer the key prompt: {e}"))?;
    match r.status().as_u16() {
        204 => Ok(()),
        404 => Err("the key prompt is gone (its turn ended)".into()),
        s => Err(format!("answer the key prompt: HTTP {s}")),
    }
}

async fn answer(engine: &EngineManager, prompt_id: String, key: String) -> Result<(), String> {
    let (addr, token) = engine.endpoint().await.ok_or("the engine is not running")?;
    blocking(move || post_answer(&addr, &token, &prompt_id, &key)).await?
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())
}

/// What `assist_key_answer` did.
#[derive(Debug, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum KeyAnswer {
    /// the remembered key answered the prompt
    Answered,
    /// none remembered: the app asks the user
    Missing { keychain: bool },
}

/// Answers the `apikey` prompt `prompt_id` with the key remembered for `provider` at the prompt's
/// endpoint, if any.
#[tauri::command]
pub async fn assist_key_answer(
    engine: tauri::State<'_, EngineManager>,
    secrets: tauri::State<'_, Arc<Secrets>>,
    prompt_id: String,
    provider: String,
) -> Result<KeyAnswer, String> {
    check_id("prompt", &prompt_id)?;
    check_id("provider", &provider)?;
    let endpoint = prompt_endpoint(&engine, &prompt_id, &provider).await?;
    let s = secrets.inner().clone();
    match blocking(move || s.find(&provider, &endpoint)).await? {
        Stored::Key(key) => {
            answer(&engine, prompt_id, key).await?;
            Ok(KeyAnswer::Answered)
        }
        Stored::Missing { keychain } => Ok(KeyAnswer::Missing { keychain }),
    }
}

/// Answers the prompt with the key the user typed, then remembers it when asked to.
#[tauri::command]
pub async fn assist_key_store_and_answer(
    engine: tauri::State<'_, EngineManager>,
    secrets: tauri::State<'_, Arc<Secrets>>,
    prompt_id: String,
    provider: String,
    key: String,
    remember: bool,
) -> Result<Kept, String> {
    check_id("prompt", &prompt_id)?;
    check_id("provider", &provider)?;
    let key = key.trim().to_string();
    let endpoint = prompt_endpoint(&engine, &prompt_id, &provider).await?;
    answer(&engine, prompt_id, key.clone()).await?;
    if key.is_empty() {
        return Ok(Kept::Engine);
    }
    let s = secrets.inner().clone();
    blocking(move || s.keep(&provider, &endpoint, &key, remember)).await
}

/// Drops the key remembered for `provider` (the engine's own copy goes with its key route).
#[tauri::command]
pub async fn assist_key_forget(
    secrets: tauri::State<'_, Arc<Secrets>>,
    provider: String,
) -> Result<(), String> {
    check_id("provider", &provider)?;
    let s = secrets.inner().clone();
    blocking(move || s.forget(&provider)).await?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;

    /// A keychain in memory; `down` makes it unavailable.
    #[derive(Default)]
    struct Mock {
        items: Mutex<HashMap<String, String>>,
        down: bool,
    }

    impl Vault for Arc<Mock> {
        fn get(&self, account: &str) -> Result<Option<String>, VaultError> {
            if self.down {
                return Err(VaultError::Unavailable("no Secret Service".into()));
            }
            Ok(self.items.lock().unwrap().get(account).cloned())
        }
        fn set(&self, account: &str, secret: &str) -> Result<(), VaultError> {
            if self.down {
                return Err(VaultError::Unavailable("no Secret Service".into()));
            }
            self.items
                .lock()
                .unwrap()
                .insert(account.into(), secret.into());
            Ok(())
        }
        fn delete(&self, account: &str) -> Result<(), VaultError> {
            if self.down {
                return Err(VaultError::Unavailable("no Secret Service".into()));
            }
            self.items.lock().unwrap().remove(account);
            Ok(())
        }
    }

    fn secrets(down: bool) -> (Secrets, Arc<Mock>) {
        let m = Arc::new(Mock {
            down,
            ..Mock::default()
        });
        (Secrets::new(Box::new(m.clone())), m)
    }

    const EP: &str = "openai https://api.example.com/v1";

    #[test]
    fn remembers_in_the_keychain_under_the_provider_account() {
        let (s, m) = secrets(false);
        assert_eq!(s.find("p1", EP), Stored::Missing { keychain: true });
        assert_eq!(s.keep("p1", EP, "sk-1", true), Kept::Keychain);
        assert_eq!(
            m.items.lock().unwrap().get("assist:p1").map(String::as_str),
            Some(r#"{"endpoint":"openai https://api.example.com/v1","key":"sk-1"}"#)
        );
        assert_eq!(s.find("p1", EP), Stored::Key("sk-1".into()));
        assert_eq!(s.find("p2", EP), Stored::Missing { keychain: true });
        s.forget("p1").unwrap();
        assert_eq!(s.find("p1", EP), Stored::Missing { keychain: true });
        assert!(m.items.lock().unwrap().is_empty());
    }

    #[test]
    fn a_key_answers_only_for_the_endpoint_it_was_kept_for() {
        let (s, m) = secrets(false);
        s.keep("p1", EP, "sk-1", true);
        let moved = "openai https://elsewhere.example/v1";
        assert_eq!(s.find("p1", moved), Stored::Missing { keychain: true });
        assert_eq!(s.find("p1", "codex"), Stored::Missing { keychain: true });
        // a secret without an endpoint (an older entry, someone else's) answers for none
        m.items
            .lock()
            .unwrap()
            .insert("assist:p1".into(), "sk-bare".into());
        assert_eq!(s.find("p1", EP), Stored::Missing { keychain: true });
        assert_eq!(s.find("p1", ""), Stored::Missing { keychain: true });
        // typed again for the new endpoint, it answers there and no longer at the old one
        s.keep("p1", moved, "sk-2", true);
        assert_eq!(s.find("p1", moved), Stored::Key("sk-2".into()));
        assert_eq!(s.find("p1", EP), Stored::Missing { keychain: true });

        let (s, _) = secrets(true);
        assert_eq!(s.keep("p1", EP, "sk-1", true), Kept::Session);
        assert_eq!(s.find("p1", moved), Stored::Missing { keychain: false });
        assert_eq!(s.find("p1", EP), Stored::Key("sk-1".into()));
    }

    #[test]
    fn only_the_providers_own_key_prompt_is_answered() {
        let p = |kind: &str, connection: &str| OpenPrompt {
            kind: kind.into(),
            connection: connection.into(),
            endpoint: EP.into(),
        };
        assert_eq!(endpoint_of(p("apikey", "p1"), "p1").unwrap(), EP);
        assert!(endpoint_of(p("apikey", "p2"), "p1").is_err());
        assert!(endpoint_of(p("password", "p1"), "p1").is_err());
    }

    #[test]
    fn reads_the_open_prompt_from_the_engine() {
        let (addr, h) = serve_once(
            200,
            r#"{"id":"p0123","connection":"p1","kind":"apikey","text":"API key","echo":false,"state":"open","endpoint":"codex"}"#,
        );
        let p = get_prompt(&addr, "tok", "p0123").unwrap();
        let (line, headers, _) = h.join().unwrap();
        assert_eq!(line, "GET /engine/prompts/p0123 HTTP/1.1\r\n");
        assert!(headers
            .to_ascii_lowercase()
            .contains("authorization: bearer tok\r\n"));
        assert_eq!(
            p,
            OpenPrompt {
                kind: "apikey".into(),
                connection: "p1".into(),
                endpoint: "codex".into()
            }
        );
        let (addr, h) = serve_once(404, "");
        assert!(get_prompt(&addr, "tok", "p0123")
            .unwrap_err()
            .contains("gone"));
        h.join().unwrap();
    }

    #[test]
    fn a_key_not_remembered_is_not_stored() {
        let (s, m) = secrets(false);
        assert_eq!(s.keep("p1", EP, "sk-1", false), Kept::Engine);
        assert!(m.items.lock().unwrap().is_empty());
        assert_eq!(s.find("p1", EP), Stored::Missing { keychain: true });
    }

    #[test]
    fn without_a_keychain_a_remembered_key_lasts_the_session() {
        let (s, _) = secrets(true);
        assert_eq!(s.find("p1", EP), Stored::Missing { keychain: false });
        assert_eq!(s.keep("p1", EP, "sk-1", true), Kept::Session);
        assert_eq!(s.find("p1", EP), Stored::Key("sk-1".into()));
        s.forget("p1").unwrap();
        assert_eq!(s.find("p1", EP), Stored::Missing { keychain: false });
    }

    #[test]
    #[ignore = "writes to the OS keychain"]
    fn the_os_keychain_keeps_a_key_across_instances() {
        let service = "com.davidbudac.mtkprof.cargo-test";
        let s = Secrets::new(Box::new(Keychain::new(service)));
        assert_eq!(s.keep("p-test", EP, "sk-cargo-test", true), Kept::Keychain);
        let again = Secrets::new(Box::new(Keychain::new(service)));
        assert_eq!(
            again.find("p-test", EP),
            Stored::Key("sk-cargo-test".into())
        );
        again.forget("p-test").unwrap();
        assert_eq!(
            Secrets::new(Box::new(Keychain::new(service))).find("p-test", EP),
            Stored::Missing { keychain: true }
        );
    }

    #[test]
    fn ids_must_be_engine_ids() {
        for ok in ["p0a1b2c3d4e5f", "openai-1", "a.b:c_d"] {
            assert!(check_id("x", ok).is_ok(), "{ok}");
        }
        for bad in ["", "../x", "a/b", "a b", "a?b", "a#b", &"a".repeat(129)] {
            assert!(check_id("x", bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn answer_command_results_serialize_for_the_webview() {
        assert_eq!(
            serde_json::to_string(&KeyAnswer::Answered).unwrap(),
            r#"{"status":"answered"}"#
        );
        assert_eq!(
            serde_json::to_string(&KeyAnswer::Missing { keychain: false }).unwrap(),
            r#"{"status":"missing","keychain":false}"#
        );
        assert_eq!(
            serde_json::to_string(&Kept::Session).unwrap(),
            r#""session""#
        );
    }

    /// One request on a loopback listener: the request line, headers and body; answers `status` and `body`.
    fn serve_once(
        status: u16,
        reply: &'static str,
    ) -> (String, std::thread::JoinHandle<(String, String, String)>) {
        let ln = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = ln.local_addr().unwrap().to_string();
        let h = std::thread::spawn(move || {
            let (mut c, _) = ln.accept().unwrap();
            let mut r = BufReader::new(c.try_clone().unwrap());
            let mut line = String::new();
            r.read_line(&mut line).unwrap();
            let (mut headers, mut len) = (String::new(), 0usize);
            loop {
                let mut h = String::new();
                r.read_line(&mut h).unwrap();
                if h == "\r\n" {
                    break;
                }
                if let Some(v) = h.to_ascii_lowercase().strip_prefix("content-length:") {
                    len = v.trim().parse().unwrap();
                }
                headers.push_str(&h);
            }
            let mut body = vec![0; len];
            r.read_exact(&mut body).unwrap();
            write!(
                c,
                "HTTP/1.1 {status} X\r\ncontent-length: {}\r\n\r\n{reply}",
                reply.len()
            )
            .unwrap();
            (line, headers, String::from_utf8(body).unwrap())
        });
        (addr, h)
    }

    #[test]
    fn posts_the_answer_to_the_engine_with_its_token() {
        let (addr, h) = serve_once(204, "");
        post_answer(&addr, "tok", "p0123", "sk-\"1\"").unwrap();
        let (line, headers, body) = h.join().unwrap();
        assert_eq!(line, "POST /engine/prompts/p0123 HTTP/1.1\r\n");
        assert!(headers
            .to_ascii_lowercase()
            .contains("authorization: bearer tok\r\n"));
        assert_eq!(body, r#"{"answer":"sk-\"1\""}"#);
    }

    #[test]
    fn a_gone_prompt_is_an_error_without_the_key() {
        let (addr, h) = serve_once(404, "");
        let e = post_answer(&addr, "tok", "p0123", "sk-secret").unwrap_err();
        h.join().unwrap();
        assert!(e.contains("gone"), "{e}");
        assert!(!e.contains("sk-secret"));
    }
}
