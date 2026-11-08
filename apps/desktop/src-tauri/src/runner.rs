//! Local runner processes. Each local thread gets its own `lemonlime-runner`
//! bound to 127.0.0.1 on a free port, with a fresh random thread secret. The
//! frontend signs short-lived client tokens with that secret and connects to
//! `ws://127.0.0.1:<port>/ws`.

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::paths;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const AGENTS: [&str; 4] = ["claude-code", "codex", "opencode", "acp"];
const READY_TIMEOUT: Duration = Duration::from_secs(20);
const STOP_GRACE: Duration = Duration::from_secs(3);

struct RunnerProcess {
    child: Child,
    port: u16,
    secret: String,
    log_path: PathBuf,
}

impl RunnerProcess {
    fn alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }
}

/// Managed state: running runners by thread id.
#[derive(Default)]
pub struct Runners(Mutex<HashMap<String, RunnerProcess>>);

impl Runners {
    fn lock(&self) -> MutexGuard<'_, HashMap<String, RunnerProcess>> {
        // A panic while holding the lock must not stop us from cleaning up later.
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// True while any runner process is still alive.
    pub fn any_alive(&self) -> bool {
        self.lock().values_mut().any(|p| p.alive())
    }

    /// Ports of the runners still alive, by thread id.
    pub fn ports(&self) -> Vec<(String, u16)> {
        self.lock().iter_mut().filter_map(|(id, p)| p.alive().then(|| (id.clone(), p.port))).collect()
    }

    /// Stops every runner. Called when the app exits.
    pub fn stop_all(&self) {
        let procs: Vec<RunnerProcess> = self.lock().drain().map(|(_, p)| p).collect();
        let handles: Vec<_> = procs.into_iter().map(|p| thread::spawn(move || terminate(p.child))).collect();
        for h in handles {
            let _ = h.join();
        }
    }
}

#[derive(Serialize, Clone)]
pub struct RunnerInfo {
    port: u16,
    secret: String,
}

struct StartRequest {
    thread_id: String,
    agent: String,
    agent_command: Option<String>,
    model: Option<String>,
    reasoning: Option<String>,
    workdir: String,
    base_branch: Option<String>,
    runner_path: Option<String>,
}

/// Starts the runner for a thread, or returns the one already running.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn start_local_runner(
    app: AppHandle,
    thread_id: String,
    agent: String,
    agent_command: Option<String>,
    model: Option<String>,
    reasoning: Option<String>,
    workdir: String,
    base_branch: Option<String>,
    runner_path: Option<String>,
) -> Result<RunnerInfo, String> {
    let req = StartRequest { thread_id, agent, agent_command, model, reasoning, workdir, base_branch, runner_path };
    tauri::async_runtime::spawn_blocking(move || start_blocking(&app, req))
        .await
        .map_err(|e| format!("Could not start the runner: {e}"))?
}

#[tauri::command]
pub async fn stop_local_runner(state: State<'_, Runners>, thread_id: String) -> Result<(), String> {
    let proc = state.lock().remove(&thread_id);
    if let Some(p) = proc {
        tauri::async_runtime::spawn_blocking(move || terminate(p.child))
            .await
            .map_err(|e| format!("Could not stop the runner: {e}"))?;
    }
    Ok(())
}

/// Stops a local thread's runner, then removes its worktree and local history.
/// The thread's branch and commits stay in the user's repository.
#[tauri::command]
pub async fn remove_local_thread(
    state: State<'_, Runners>,
    thread_id: String,
    repo_path: String,
    runner_path: Option<String>,
) -> Result<(), String> {
    if !valid_thread_id(&thread_id) {
        return Err("That thread id is not valid.".into());
    }
    let proc = state.lock().remove(&thread_id);
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(p) = proc {
            terminate(p.child);
        }
        let program = paths::resolve_program(runner_path.as_deref(), "lemonlime-runner")?;
        let mut cmd = runner_command(&program)?;
        cmd.arg("cleanup")
            .arg("--thread")
            .arg(&thread_id)
            .arg("--source-repo")
            .arg(&repo_path)
            .env("PATH", paths::search_path())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let out = cmd.output().map_err(|e| format!("Could not run the runner: {e}"))?;
        if out.status.success() {
            Ok(())
        } else {
            Err(format!("Could not clean up the thread: {}", String::from_utf8_lossy(&out.stderr).trim()))
        }
    })
    .await
    .map_err(|e| format!("Could not clean up the thread: {e}"))?
}

#[tauri::command]
pub fn local_runner_running(state: State<'_, Runners>, thread_id: String) -> bool {
    let mut runners = state.lock();
    let alive = runners.get_mut(&thread_id).map(|p| p.alive());
    if alive == Some(false) {
        runners.remove(&thread_id);
    }
    alive == Some(true)
}

#[tauri::command]
pub fn list_local_runners(state: State<'_, Runners>) -> Vec<String> {
    let mut runners = state.lock();
    runners.retain(|_, p| p.alive());
    runners.keys().cloned().collect()
}

fn start_blocking(app: &AppHandle, req: StartRequest) -> Result<RunnerInfo, String> {
    if !valid_thread_id(&req.thread_id) {
        return Err("That thread id is not valid.".into());
    }
    if !AGENTS.contains(&req.agent.as_str()) {
        return Err(format!("Unknown agent \"{}\".", req.agent));
    }
    let agent_command = non_empty(req.agent_command);
    if req.agent == "acp" && agent_command.is_none() {
        return Err("ACP agents need a command.".into());
    }
    let workdir = PathBuf::from(&req.workdir);
    if !workdir.is_dir() {
        return Err(format!("The repository folder no longer exists: {}", workdir.display()));
    }

    // Resolve everything slow before taking the lock.
    let program = paths::resolve_program(req.runner_path.as_deref(), "lemonlime-runner")?;
    let log_dir = app.path().app_log_dir().map_err(|e| format!("Could not find the log folder: {e}"))?;
    fs::create_dir_all(&log_dir).map_err(|e| format!("Could not create {}: {e}", log_dir.display()))?;
    let log_path = log_dir.join(format!("runner-{}.log", req.thread_id));

    let state = app.state::<Runners>();
    let (info, log_path) = {
        let mut runners = state.lock();

        if let Some(existing) = runners.get_mut(&req.thread_id) {
            if existing.alive() {
                let info = RunnerInfo { port: existing.port, secret: existing.secret.clone() };
                let log = existing.log_path.clone();
                drop(runners);
                wait_until_ready(app, &req.thread_id, info.port, &log)?;
                return Ok(info);
            }
            runners.remove(&req.thread_id);
        }

        let port = free_port()?;
        let secret = random_secret();
        let log = open_log(&log_path)?;
        let log_err = log.try_clone().map_err(|e| format!("Could not open the runner log: {e}"))?;

        let mut cmd = runner_command(&program)?;
        cmd.arg("--thread")
            .arg(&req.thread_id)
            .arg("--agent")
            .arg(&req.agent)
            // The runner works in its own git worktree of this repository, so the
            // user's checked-out branch and uncommitted work are never touched.
            .arg("--source-repo")
            .arg(&workdir)
            .arg("--port")
            .arg(port.to_string())
            .arg("--host")
            .arg("127.0.0.1");
        if let Some(c) = &agent_command {
            cmd.arg("--agent-command").arg(c);
        }
        if let Some(m) = non_empty(req.model) {
            cmd.arg("--model").arg(m);
        }
        // Only the levels the runner knows; anything else is dropped rather than passed on.
        if let Some(r) = non_empty(req.reasoning).filter(|r| ["low", "medium", "high", "xhigh", "max", "ultra"].contains(&r.as_str())) {
            cmd.arg("--reasoning").arg(r);
        }
        if let Some(b) = non_empty(req.base_branch) {
            cmd.arg("--base").arg(b);
        }
        // The terminal's native PTY module ships next to the bundled runner, which can't carry it.
        if let Ok(pty) = app.path().resolve("node-pty", tauri::path::BaseDirectory::Resource) {
            if pty.join("node_modules").is_dir() {
                cmd.env("LEMONLIME_NODE_PTY_DIR", pty);
            }
        }
        // Skills ship as an app resource; the bundled runner can't find them on its own.
        if let Ok(skills) = app.path().resolve("skills", tauri::path::BaseDirectory::Resource) {
            if skills.is_dir() {
                cmd.env("LEMONLIME_SKILLS_DIR", skills);
            }
        }
        cmd.env("LEMONLIME_THREAD_SECRET", &secret)
            .env("PATH", paths::search_path())
            .env_remove("LEMONLIME_RUNNER_PORT")
            .current_dir(&workdir)
            .stdin(Stdio::null())
            .stdout(Stdio::from(log))
            .stderr(Stdio::from(log_err));
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        let child = cmd
            .spawn()
            .map_err(|e| format!("Could not start {}: {e}", program.display()))?;

        runners.insert(
            req.thread_id.clone(),
            RunnerProcess { child, port, secret: secret.clone(), log_path: log_path.clone() },
        );
        (RunnerInfo { port, secret }, log_path)
    };

    wait_until_ready(app, &req.thread_id, info.port, &log_path)?;
    Ok(info)
}

/// Waits until the runner accepts TCP connections. Fails early if it exits.
/// If it is merely slow, returns Ok and lets the client keep retrying.
fn wait_until_ready(app: &AppHandle, thread_id: &str, port: u16, log_path: &Path) -> Result<(), String> {
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let deadline = Instant::now() + READY_TIMEOUT;
    loop {
        if TcpStream::connect_timeout(&addr, Duration::from_millis(250)).is_ok() {
            return Ok(());
        }
        {
            let state = app.state::<Runners>();
            let mut runners = state.lock();
            let exited = match runners.get_mut(thread_id) {
                Some(p) => match p.child.try_wait() {
                    Ok(Some(status)) => Some(status.to_string()),
                    Ok(None) => None,
                    Err(e) => Some(e.to_string()),
                },
                // Stopped by someone else meanwhile.
                None => return Err("The runner was stopped.".into()),
            };
            if let Some(status) = exited {
                runners.remove(thread_id);
                drop(runners);
                let tail = log_tail(log_path);
                return Err(if tail.is_empty() {
                    format!("The runner exited right away ({status}).")
                } else {
                    format!("The runner exited right away ({status}):\n{tail}")
                });
            }
        }
        if Instant::now() >= deadline {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(150));
    }
}

/// Asks the runner to shut down cleanly, then forces it after a grace period.
pub(crate) fn terminate(mut child: Child) {
    if matches!(child.try_wait(), Ok(Some(_))) {
        return;
    }

    #[cfg(unix)]
    {
        // SIGTERM lets the runner stop its agent and flush history.
        unsafe {
            libc::kill(child.id() as libc::pid_t, libc::SIGTERM);
        }
        let deadline = Instant::now() + STOP_GRACE;
        while Instant::now() < deadline {
            if matches!(child.try_wait(), Ok(Some(_))) {
                return;
            }
            thread::sleep(Duration::from_millis(100));
        }
    }

    #[cfg(windows)]
    {
        // Windows has no SIGTERM; end the whole tree (runner, shims, agent).
        use std::os::windows::process::CommandExt;
        let _ = Command::new("taskkill")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        let _ = STOP_GRACE;
    }

    let _ = child.kill();
    let _ = child.wait();
}

/// A command that runs the runner. Script paths (e.g. the checkout's
/// `packages/runner/bin/lemonlime-runner.js`) are run with Node, which also
/// makes them work on Windows.
pub(crate) fn runner_command(program: &Path) -> Result<Command, String> {
    let is_script = program
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| matches!(e.to_ascii_lowercase().as_str(), "js" | "mjs" | "cjs"))
        .unwrap_or(false);
    if !is_script {
        return Ok(Command::new(program));
    }
    let node = paths::find_program("node")
        .ok_or_else(|| "Node.js 22 or newer is needed to run the runner script, but `node` is not on your PATH.".to_string())?;
    let mut cmd = Command::new(node);
    cmd.arg(program);
    Ok(cmd)
}

fn valid_thread_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    (6..=64).contains(&bytes.len())
        && bytes[0].is_ascii_alphanumeric()
        && bytes.iter().all(|b| b.is_ascii_digit() || b.is_ascii_lowercase() || *b == b'-')
}

fn non_empty(v: Option<String>) -> Option<String> {
    v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// 32 random bytes, hex encoded.
fn random_secret() -> String {
    let bytes: [u8; 32] = rand::random();
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Asks the OS for a free port on the loopback interface.
fn free_port() -> Result<u16, String> {
    TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .map_err(|e| format!("Could not find a free port: {e}"))
}

fn open_log(path: &Path) -> Result<File, String> {
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| format!("Could not open {}: {e}", path.display()))
}

/// The last few lines of a runner log, for error messages.
fn log_tail(path: &Path) -> String {
    const MAX_BYTES: u64 = 4096;
    let Ok(mut f) = File::open(path) else { return String::new() };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let _ = f.seek(SeekFrom::Start(len.saturating_sub(MAX_BYTES)));
    let mut buf = Vec::new();
    if f.read_to_end(&mut buf).is_err() {
        return String::new();
    }
    let text = String::from_utf8_lossy(&buf);
    let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    lines[lines.len().saturating_sub(12)..].join("\n")
}
