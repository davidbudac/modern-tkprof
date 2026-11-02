//! The engine sidecar (docs/PLAN-DESKTOP.md § 2 and § 7 at the repository root): `mtkprof-engine
//! engine` with a fresh bearer token in `MTKPROF_TOKEN` (never in argv), stdin held open (the
//! engine exits when it closes, so it cannot outlive the app), and the JSON ready line from its
//! stdout. A watcher per run forwards the engine's output to the log and, when the engine exits
//! unexpectedly, emits `engine://crashed` and restarts it with backoff (at once, 1 s, 5 s); a
//! fourth crash within a minute gives up with `engine://failed`. Every successful start emits
//! `engine://ready`. On macOS and Linux the engine runs with the user's login-shell PATH, so the
//! CLI agents it looks up (claude, codex) are found when the app was started from the Finder.

use std::collections::VecDeque;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
#[cfg(unix)]
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use tauri::async_runtime::{Mutex, Receiver};
use tauri::{Emitter, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use tokio::sync::watch;

/// The engine protocol this shell speaks.
pub const PROTOCOL: u32 = 1;

/// The sidecar's name in `externalBin` (`binaries/mtkprof-engine-<triple>`).
const SIDECAR: &str = "mtkprof-engine";
const READY_TIMEOUT: Duration = Duration::from_secs(10);
const STOP_TIMEOUT: Duration = Duration::from_secs(3);
const CRASH_WINDOW: Duration = Duration::from_secs(60);
/// Delay before the restart after the 1st, 2nd and 3rd crash within `CRASH_WINDOW`.
const BACKOFF: [Duration; 3] = [
    Duration::ZERO,
    Duration::from_secs(1),
    Duration::from_secs(5),
];

pub const EV_READY: &str = "engine://ready";
pub const EV_CRASHED: &str = "engine://crashed";
pub const EV_FAILED: &str = "engine://failed";

fn allow_origins() -> &'static str {
    if cfg!(debug_assertions) {
        "tauri://localhost,http://tauri.localhost,http://localhost:5173"
    } else {
        "tauri://localhost,http://tauri.localhost"
    }
}

/// What `engine_start` answers and `engine://ready` carries.
#[derive(Clone, Serialize)]
pub struct EngineInfo {
    addr: String,
    token: String,
    version: String,
    protocol: u32,
    /// automatic restarts since the app started
    restarts: u32,
}

/// Engine flags the app may set (S4 settings); `None` keeps the default.
#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineOptions {
    /// index cache directory (default `<app cache dir>/mtkprof`)
    cache_dir: Option<String>,
    /// index cache cap, e.g. `20G`
    cache_cap: Option<String>,
    plan_viz_url: Option<String>,
}

#[derive(Clone, Serialize)]
struct Crashed {
    code: Option<i32>,
    signal: Option<i32>,
    message: String,
}

#[derive(Clone, Serialize)]
struct Failed {
    message: String,
}

#[derive(Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
enum State {
    Stopped,
    Running,
    Crashed,
    Failed,
}

#[derive(Serialize)]
pub struct EngineStatus {
    state: State,
    pid: Option<u32>,
    /// seconds since the running engine started
    uptime: Option<u64>,
    restarts: u32,
    error: Option<String>,
}

#[derive(Deserialize)]
struct Ready {
    ready: bool,
    addr: String,
    version: String,
    protocol: u32,
}

struct Inner {
    // dropping the child closes its stdin, which stops the engine
    child: Option<CommandChild>,
    info: Option<EngineInfo>,
    /// set by the run's watcher once the process is gone
    exited: Option<watch::Receiver<bool>>,
    /// bumped by every start and every deliberate stop: a watcher whose run is no longer the
    /// current one ignores its process's exit
    run: u64,
    state: State,
    started: Option<Instant>,
    restarts: u32,
    crashes: VecDeque<Instant>,
    error: Option<String>,
    opts: EngineOptions,
}

/// The engine process and its restart bookkeeping, shared by the commands and the watchers.
#[derive(Clone)]
pub struct EngineManager(Arc<Mutex<Inner>>);

impl Default for EngineManager {
    fn default() -> Self {
        EngineManager(Arc::new(Mutex::new(Inner {
            child: None,
            info: None,
            exited: None,
            run: 0,
            state: State::Stopped,
            started: None,
            restarts: 0,
            crashes: VecDeque::new(),
            error: None,
            opts: EngineOptions::default(),
        })))
    }
}

fn new_token() -> Result<String, String> {
    let mut buf = [0u8; 48];
    getrandom::fill(&mut buf).map_err(|e| format!("token: {e}"))?;
    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(buf))
}

fn log_line(line: &[u8]) {
    let s = String::from_utf8_lossy(line);
    let s = s.trim_end();
    if !s.is_empty() {
        log::info!(target: "engine", "{s}");
    }
}

/// A start that failed; `fatal` ones (protocol mismatch) are not retried.
struct StartError {
    message: String,
    fatal: bool,
}

impl From<String> for StartError {
    fn from(message: String) -> Self {
        StartError {
            message,
            fatal: false,
        }
    }
}

fn kill_and_fail(child: CommandChild, e: StartError) -> Result<EngineInfo, StartError> {
    let _ = child.kill();
    Err(e)
}

type BoxFuture = Pin<Box<dyn Future<Output = ()> + Send>>;

/// `<app cache dir>/mtkprof`, the index cache unless the settings name another.
pub fn default_cache_dir(app: &tauri::AppHandle) -> Result<String, String> {
    Ok(app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("app cache dir: {e}"))?
        .join("mtkprof")
        .to_string_lossy()
        .into_owned())
}

impl EngineManager {
    /// The cache directory the engine runs (or will run) with.
    pub async fn cache_dir(&self, app: &tauri::AppHandle) -> Result<String, String> {
        let dir = self.0.lock().await.opts.cache_dir.clone();
        match dir {
            Some(d) => Ok(d),
            None => default_cache_dir(app),
        }
    }

    /// Spawns the engine and waits for its ready line. The caller holds the lock (`g`).
    async fn spawn(&self, app: &tauri::AppHandle, g: &mut Inner) -> Result<EngineInfo, StartError> {
        let token = new_token()?;
        let cache_dir = match &g.opts.cache_dir {
            Some(d) => d.clone(),
            None => default_cache_dir(app)?,
        };
        let mut args: Vec<String> = vec![
            "engine".into(),
            "-allow-origin".into(),
            allow_origins().into(),
            "-cache".into(),
            cache_dir,
        ];
        if let Some(c) = &g.opts.cache_cap {
            args.extend(["-cache-cap".into(), c.clone()]);
        }
        if let Some(u) = &g.opts.plan_viz_url {
            args.extend(["-plan-viz-url".into(), u.clone()]);
        }
        let cmd = app
            .shell()
            .sidecar(SIDECAR)
            .map_err(|e| format!("engine sidecar: {e}"))?
            .args(args)
            .env("MTKPROF_TOKEN", &token);
        #[cfg(unix)]
        let cmd = cmd.env(
            "PATH",
            tauri::async_runtime::spawn_blocking(engine_path)
                .await
                .map_err(|e| format!("engine PATH: {e}"))?,
        );
        let (mut rx, child) = cmd.spawn().map_err(|e| format!("engine spawn: {e}"))?;

        let first = tokio::time::timeout(READY_TIMEOUT, async {
            while let Some(ev) = rx.recv().await {
                match ev {
                    CommandEvent::Stdout(line) => return Ok(line),
                    CommandEvent::Stderr(line) => log_line(&line),
                    CommandEvent::Terminated(t) => {
                        return Err(format!("engine exited before ready (code {:?})", t.code))
                    }
                    CommandEvent::Error(e) => return Err(format!("engine: {e}")),
                    _ => {}
                }
            }
            Err("engine closed its output before ready".to_string())
        })
        .await
        .unwrap_or_else(|_| {
            Err(format!(
                "engine did not report ready within {} s",
                READY_TIMEOUT.as_secs()
            ))
        });
        let line = match first {
            Ok(l) => l,
            Err(e) => return kill_and_fail(child, e.into()),
        };
        let ready: Ready = match serde_json::from_slice::<Ready>(&line) {
            Ok(r) if r.ready => r,
            _ => {
                let e = format!("engine ready line {:?}", String::from_utf8_lossy(&line));
                return kill_and_fail(child, e.into());
            }
        };
        if ready.protocol != PROTOCOL {
            let message = format!(
                "protocol mismatch (engine {}, app {PROTOCOL})",
                ready.protocol
            );
            return kill_and_fail(
                child,
                StartError {
                    message,
                    fatal: true,
                },
            );
        }

        g.run += 1;
        let (exited_tx, exited_rx) = watch::channel(false);
        let info = EngineInfo {
            addr: ready.addr,
            token,
            version: ready.version,
            protocol: ready.protocol,
            restarts: g.restarts,
        };
        log::info!(
            "engine {} ready on {} (pid {})",
            info.version,
            info.addr,
            child.pid()
        );
        g.child = Some(child);
        g.info = Some(info.clone());
        g.exited = Some(exited_rx);
        g.state = State::Running;
        g.started = Some(Instant::now());
        g.error = None;
        tauri::async_runtime::spawn(self.watcher(app.clone(), g.run, rx, exited_tx));
        Ok(info)
    }

    // Boxed so that spawn -> watch -> recover -> spawn is not a recursive opaque future type.
    fn watcher(
        &self,
        app: tauri::AppHandle,
        run: u64,
        rx: Receiver<CommandEvent>,
        exited: watch::Sender<bool>,
    ) -> BoxFuture {
        Box::pin(self.clone().watch(app, run, rx, exited))
    }

    /// Drains one run's output (so its pipes never fill) until the process exits.
    async fn watch(
        self,
        app: tauri::AppHandle,
        run: u64,
        mut rx: Receiver<CommandEvent>,
        exited: watch::Sender<bool>,
    ) {
        let (mut code, mut signal) = (None, None);
        while let Some(ev) = rx.recv().await {
            match ev {
                CommandEvent::Stdout(l) | CommandEvent::Stderr(l) => log_line(&l),
                CommandEvent::Terminated(t) => {
                    (code, signal) = (t.code, t.signal);
                    break;
                }
                CommandEvent::Error(e) => log::warn!("engine: {e}"),
                _ => {}
            }
        }
        let _ = exited.send(true);
        self.recover(app, run, code, signal).await;
    }

    /// Restarts the engine after run `run` ended, unless that exit was deliberate.
    async fn recover(
        &self,
        app: tauri::AppHandle,
        run: u64,
        mut code: Option<i32>,
        mut signal: Option<i32>,
    ) {
        let mut message = match (code, signal) {
            (_, Some(s)) => format!("the engine was killed by signal {s}"),
            (Some(c), None) => format!("the engine exited with code {c}"),
            (None, None) => "the engine exited".to_string(),
        };
        loop {
            let delay = {
                let mut g = self.0.lock().await;
                if g.run != run {
                    return; // stopped or restarted on purpose
                }
                log::warn!("{message}");
                g.child = None;
                g.info = None;
                g.exited = None;
                g.started = None;
                g.state = State::Crashed;
                let _ = app.emit(
                    EV_CRASHED,
                    Crashed {
                        code,
                        signal,
                        message: message.clone(),
                    },
                );
                let now = Instant::now();
                g.crashes.retain(|t| now.duration_since(*t) < CRASH_WINDOW);
                g.crashes.push_back(now);
                match BACKOFF.get(g.crashes.len() - 1) {
                    Some(d) => *d,
                    None => {
                        let m = format!(
                            "the engine crashed {} times within a minute: {message}",
                            g.crashes.len()
                        );
                        give_up(&app, &mut g, m);
                        return;
                    }
                }
            };
            tokio::time::sleep(delay).await;
            let mut g = self.0.lock().await;
            if g.run != run {
                return;
            }
            g.restarts += 1;
            match self.spawn(&app, &mut g).await {
                Ok(info) => {
                    let _ = app.emit(EV_READY, info);
                    return;
                }
                Err(e) if e.fatal => {
                    g.restarts -= 1;
                    give_up(&app, &mut g, e.message);
                    return;
                }
                Err(e) => {
                    g.restarts -= 1;
                    (code, signal, message) = (None, None, e.message);
                }
            }
        }
    }

    /// Starts the engine unless it runs; `opts` replace the stored options when given.
    pub async fn start(
        &self,
        app: &tauri::AppHandle,
        opts: Option<EngineOptions>,
    ) -> Result<EngineInfo, String> {
        let mut g = self.0.lock().await;
        if let Some(info) = &g.info {
            return Ok(info.clone());
        }
        if let Some(o) = opts {
            g.opts = o;
        }
        match self.spawn(app, &mut g).await {
            Ok(info) => {
                let _ = app.emit(EV_READY, info.clone());
                Ok(info)
            }
            Err(e) => {
                log::error!("{}", e.message);
                g.state = State::Failed;
                g.error = Some(e.message.clone());
                Err(e.message)
            }
        }
    }

    /// Stops the engine: closes its stdin and waits up to `STOP_TIMEOUT` for it to exit.
    pub async fn stop(&self) {
        let exited = {
            let mut g = self.0.lock().await;
            g.run += 1;
            g.info = None;
            g.started = None;
            g.state = State::Stopped;
            g.crashes.clear();
            g.child.take(); // closes stdin
            g.exited.take()
        };
        if let Some(mut rx) = exited {
            let _ = tokio::time::timeout(STOP_TIMEOUT, rx.wait_for(|e| *e)).await;
        }
    }

    pub async fn running(&self) -> bool {
        self.0.lock().await.state == State::Running
    }

    /// The running engine's address and token.
    pub async fn endpoint(&self) -> Option<(String, String)> {
        let g = self.0.lock().await;
        g.info.as_ref().map(|i| (i.addr.clone(), i.token.clone()))
    }

    pub async fn status(&self) -> EngineStatus {
        let g = self.0.lock().await;
        EngineStatus {
            state: g.state,
            pid: g.child.as_ref().map(|c| c.pid()),
            uptime: g.started.map(|t| t.elapsed().as_secs()),
            restarts: g.restarts,
            error: g.error.clone(),
        }
    }

    /// Kills the engine as a crash would (dev builds and smoke runs): the watcher restarts it.
    pub async fn kill(&self) -> Result<(), String> {
        let child = self.0.lock().await.child.take();
        let child = child.ok_or("the engine is not running")?;
        log::warn!("killing engine pid {} (simulated crash)", child.pid());
        tauri::async_runtime::spawn_blocking(move || child.kill())
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string())
    }
}

/// Where the CLI agents usually live, added to the engine's PATH when missing (`~` is $HOME).
#[cfg(unix)]
const AGENT_DIRS: [&str; 3] = ["/opt/homebrew/bin", "/usr/local/bin", "~/.local/bin"];
#[cfg(unix)]
const SHELL_TIMEOUT: Duration = Duration::from_secs(3);

/// The engine's PATH, resolved once: the login shell's, then the app's own, then `AGENT_DIRS`.
#[cfg(unix)]
fn engine_path() -> &'static str {
    static PATH: OnceLock<String> = OnceLock::new();
    PATH.get_or_init(|| {
        let shell = shell_path();
        if shell.is_none() {
            log::warn!(
                "no PATH from the login shell; the engine gets the app's PATH and the usual dirs"
            );
        }
        join_path(
            &[
                shell.as_deref().unwrap_or(""),
                &std::env::var("PATH").unwrap_or_default(),
            ],
            &std::env::var("HOME").unwrap_or_default(),
        )
    })
}

/// `$SHELL -l -i -c` printing PATH between markers (the rc files may print too), or None after
/// `SHELL_TIMEOUT`. Interactive as well as login: nvm, for one, sets the PATH of npm's global
/// installs in `.zshrc` / `.bashrc` only.
#[cfg(unix)]
fn shell_path() -> Option<String> {
    use std::io::Read;
    use std::process::{Command, Stdio};
    const MARK: &str = "_MTKPROF_PATH_";
    let shell = std::env::var("SHELL").ok().filter(|s| s.starts_with('/'))?;
    let mut child = Command::new(shell)
        .args([
            "-l",
            "-i",
            "-c",
            &format!("printf '{MARK}%s{MARK}' \"$PATH\""),
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut out = child.stdout.take()?;
    let (tx, rx) = std::sync::mpsc::channel();
    // stops at the second marker: a process the rc files started may hold the pipe open
    std::thread::spawn(move || {
        let (mut got, mut buf) = (Vec::new(), [0u8; 4096]);
        while let Ok(n @ 1..) = out.read(&mut buf) {
            got.extend_from_slice(&buf[..n]);
            if String::from_utf8_lossy(&got).matches(MARK).count() >= 2 {
                break;
            }
        }
        let _ = tx.send(String::from_utf8_lossy(&got).into_owned());
    });
    let got = rx.recv_timeout(SHELL_TIMEOUT).ok();
    let _ = child.kill();
    let _ = child.wait();
    let got = got?;
    let (_, rest) = got.split_once(MARK)?;
    let (path, _) = rest.split_once(MARK)?;
    Some(path.to_string()).filter(|p| !p.is_empty())
}

/// The entries of `parts` (PATH strings) in order without repeats, then the missing `AGENT_DIRS`.
#[cfg(unix)]
fn join_path(parts: &[&str], home: &str) -> String {
    let agents = AGENT_DIRS.iter().filter_map(|d| match d.strip_prefix('~') {
        Some(_) if home.is_empty() => None,
        Some(rest) => Some(format!("{home}{rest}")),
        None => Some(d.to_string()),
    });
    let mut out: Vec<String> = Vec::new();
    for dir in parts
        .iter()
        .flat_map(|p| p.split(':'))
        .map(str::to_string)
        .chain(agents)
    {
        if !dir.is_empty() && !out.contains(&dir) {
            out.push(dir);
        }
    }
    out.join(":")
}

fn give_up(app: &tauri::AppHandle, g: &mut Inner, message: String) {
    log::error!("{message}");
    g.state = State::Failed;
    g.error = Some(message.clone());
    g.crashes.clear();
    let _ = app.emit(EV_FAILED, Failed { message });
}

/// Dev builds, or `MTKPROF_SMOKE=1`: the UI offers "Kill engine" and `engine_kill` works.
pub fn dev_tools() -> bool {
    cfg!(debug_assertions) || std::env::var("MTKPROF_SMOKE").is_ok_and(|v| v == "1")
}

/// Starts the engine, or answers the running one's address and token.
#[tauri::command]
pub async fn engine_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, EngineManager>,
    opts: Option<EngineOptions>,
) -> Result<EngineInfo, String> {
    state.start(&app, opts).await
}

/// Stops the engine (no automatic restart).
#[tauri::command]
pub async fn engine_stop(state: tauri::State<'_, EngineManager>) -> Result<(), String> {
    state.stop().await;
    Ok(())
}

/// Stops and starts the engine, with new options when given; also the way out of `failed`.
#[tauri::command]
pub async fn engine_restart(
    app: tauri::AppHandle,
    state: tauri::State<'_, EngineManager>,
    opts: Option<EngineOptions>,
) -> Result<EngineInfo, String> {
    state.stop().await;
    state.start(&app, opts).await
}

#[tauri::command]
pub async fn engine_status(state: tauri::State<'_, EngineManager>) -> Result<EngineStatus, String> {
    Ok(state.status().await)
}

/// Kills the engine to exercise the restart path (dev builds and smoke runs only).
#[tauri::command]
pub async fn engine_kill(state: tauri::State<'_, EngineManager>) -> Result<(), String> {
    if !dev_tools() {
        return Err("engine_kill is available in debug builds and smoke runs only".into());
    }
    state.kill().await
}

#[tauri::command]
pub fn engine_dev_tools() -> bool {
    dev_tools()
}

#[cfg(all(test, unix))]
mod tests {
    use super::{engine_path, join_path};

    /// Run with a Finder-like environment:
    /// `env -i HOME=$HOME SHELL=$SHELL PATH=/usr/bin:/bin <test binary> --ignored --nocapture login_shell`
    #[test]
    #[ignore = "runs the user's login shell"]
    fn login_shell_path() {
        let p = engine_path();
        println!("engine PATH: {p}");
        assert!(p.split(':').count() > 4, "{p}");
    }

    #[test]
    fn join_path_keeps_order_drops_repeats_and_adds_the_agent_dirs() {
        assert_eq!(
            join_path(&["/a:/usr/local/bin:/b", "/b:/c::"], "/home/u"),
            "/a:/usr/local/bin:/b:/c:/opt/homebrew/bin:/home/u/.local/bin"
        );
        assert_eq!(
            join_path(&["", "/usr/bin:/bin"], ""),
            "/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin"
        );
    }
}
