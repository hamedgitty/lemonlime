//! Local runner processes. Each local thread gets its own `lemonlime-runner`
//! bound to 127.0.0.1 on a free port, with a fresh random thread secret. The
//! frontend signs short-lived client tokens with that secret and connects to
//! `ws://127.0.0.1:<port>/ws`.
//!
//! The secret is sent to the runner on its stdin (`--secret-stdin`), never in its
//! environment or on its command line, where other programs running as the same user
//! could read it for as long as the runner lives.

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::paths;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub(crate) const AGENTS: [&str; 4] = ["claude-code", "codex", "opencode", "acp"];
const READY_TIMEOUT: Duration = Duration::from_secs(20);
const STOP_GRACE: Duration = Duration::from_secs(3);

pub(crate) struct RunnerProcess {
    pub(crate) child: Child,
    pub(crate) port: u16,
    pub(crate) secret: String,
    pub(crate) log_path: PathBuf,
    /// The pipe the thread secret was sent on, kept open for as long as the thread runs.
    /// Closing it tells the runner to stop; for a thread on another machine it is the ssh
    /// session's stdin, and closing it ends the session and the remote runner with it.
    pub(crate) stdin: Option<ChildStdin>,
}

impl RunnerProcess {
    pub(crate) fn alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }
}

/// Managed state: running runners by thread id.
#[derive(Default)]
pub struct Runners(Mutex<HashMap<String, RunnerProcess>>);

impl Runners {
    pub(crate) fn lock(&self) -> MutexGuard<'_, HashMap<String, RunnerProcess>> {
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
        let handles: Vec<_> = procs.into_iter().map(|p| thread::spawn(move || stop(p))).collect();
        for h in handles {
            let _ = h.join();
        }
    }
}

#[derive(Serialize, Clone)]
pub struct RunnerInfo {
    pub(crate) port: u16,
    pub(crate) secret: String,
}

struct StartRequest {
    thread_id: String,
    agent: String,
    agent_command: Option<String>,
    model: Option<String>,
    reasoning: Option<String>,
    fast: bool,
    workdir: String,
    base_branch: Option<String>,
    runner_path: Option<String>,
    settings: RunnerSettings,
    start: BranchStart,
}

/// The user's settings for local threads, passed to the runner as flags.
#[derive(Default)]
pub(crate) struct RunnerSettings {
    /// Custom instructions; written to a file in the app's data folder (--instructions-file).
    pub(crate) instructions: Option<String>,
    strip_coauthors: bool,
    branch_prefix: Option<String>,
    retry_max_wait_minutes: Option<u32>,
    disabled_skills: Vec<String>,
    /// False turns the command guard off (--no-command-guard).
    command_guard: bool,
}

impl RunnerSettings {
    /// The settings as the frontend sends them, with anything odd dropped.
    pub(crate) fn from_frontend(
        instructions: Option<String>,
        strip_coauthors: Option<bool>,
        branch_prefix: Option<String>,
        retry_max_wait_minutes: Option<f64>,
        disabled_skills: Option<Vec<String>>,
        command_guard: Option<bool>,
    ) -> Self {
        RunnerSettings {
            instructions: non_empty(instructions),
            strip_coauthors: strip_coauthors.unwrap_or(false),
            branch_prefix: non_empty(branch_prefix),
            retry_max_wait_minutes: retry_max_wait_minutes.filter(|m| m.is_finite() && *m > 0.0).map(|m| m.round().min(u32::MAX as f64) as u32),
            disabled_skills: disabled_skills.unwrap_or_default().into_iter().filter(|s| valid_skill_name(s)).collect(),
            command_guard: command_guard.unwrap_or(true),
        }
    }
}

/// The runner flags a thread's agent and settings turn into, the same on this computer and
/// on another machine (everything but the instructions file, which is a local path).
pub(crate) fn thread_flags(
    agent_command: Option<&str>,
    model: Option<String>,
    reasoning: Option<String>,
    fast: bool,
    base_branch: Option<String>,
    s: &RunnerSettings,
) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut flag = |name: &str, value: Option<String>| {
        out.push(name.to_string());
        if let Some(v) = value {
            out.push(v);
        }
    };
    if let Some(c) = agent_command {
        flag("--agent-command", Some(c.to_string()));
    }
    if let Some(m) = non_empty(model) {
        flag("--model", Some(m));
    }
    // Only the levels the runner knows; anything else is dropped rather than passed on.
    if let Some(r) = non_empty(reasoning).filter(|r| ["low", "medium", "high", "xhigh", "max", "ultra"].contains(&r.as_str())) {
        flag("--reasoning", Some(r));
    }
    if fast {
        flag("--fast", None);
    }
    // A value starting with "-" would read as a flag, so never pass one.
    if let Some(b) = non_empty(base_branch).filter(|b| !b.starts_with('-')) {
        flag("--base", Some(b));
    }
    if s.strip_coauthors {
        flag("--strip-coauthors", None);
    }
    // The runner checks the prefix is a safe branch name; "--" would read as a flag, so not that.
    if let Some(p) = s.branch_prefix.as_ref().filter(|p| !p.starts_with('-')) {
        flag("--branch-prefix", Some(p.clone()));
    }
    if let Some(m) = s.retry_max_wait_minutes {
        flag("--retry-max-wait", Some(m.to_string()));
    }
    if !s.disabled_skills.is_empty() {
        flag("--disable-skills", Some(s.disabled_skills.join(",")));
    }
    if !s.command_guard {
        flag("--no-command-guard", None);
    }
    out
}

/// Where a new thread's branch starts: on an existing branch (maybe a pull request's), or
/// from another commit (a fork). Passed on every start; the runner keeps what it set up first.
#[derive(Default)]
pub(crate) struct BranchStart {
    branch: Option<String>,
    start_from: Option<String>,
    pull_request: Option<u32>,
}

impl BranchStart {
    pub(crate) fn from_frontend(branch: Option<String>, start_from: Option<String>, pull_request: Option<u32>) -> Self {
        // The runner checks these are usable git names; one starting with "-" would read as a flag.
        let ok = |v: Option<String>| non_empty(v).filter(|v| !v.starts_with('-') && v.len() <= 250);
        let branch = ok(branch);
        BranchStart { pull_request: pull_request.filter(|n| *n > 0 && branch.is_some()), start_from: ok(start_from).filter(|_| branch.is_none()), branch }
    }

    pub(crate) fn flags(&self) -> Vec<String> {
        let mut out = Vec::new();
        if let Some(b) = &self.branch {
            out.extend(["--branch".to_string(), b.clone()]);
        }
        if let Some(n) = self.pull_request {
            out.extend(["--pull-request".to_string(), n.to_string()]);
        }
        if let Some(f) = &self.start_from {
            out.extend(["--start-from".to_string(), f.clone()]);
        }
        out
    }
}

/// What a skill name may look like, so nothing odd ends up on the runner's command line.
fn valid_skill_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && !name.starts_with(['-', '.'])
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
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
    fast: Option<bool>,
    workdir: String,
    base_branch: Option<String>,
    runner_path: Option<String>,
    instructions: Option<String>,
    strip_coauthors: Option<bool>,
    branch_prefix: Option<String>,
    retry_max_wait_minutes: Option<f64>,
    disabled_skills: Option<Vec<String>>,
    command_guard: Option<bool>,
    thread_branch: Option<String>,
    start_from: Option<String>,
    pull_request: Option<u32>,
) -> Result<RunnerInfo, String> {
    let settings = RunnerSettings::from_frontend(instructions, strip_coauthors, branch_prefix, retry_max_wait_minutes, disabled_skills, command_guard);
    let start = BranchStart::from_frontend(thread_branch, start_from, pull_request);
    let req = StartRequest { thread_id, agent, agent_command, model, reasoning, fast: fast.unwrap_or(false), workdir, base_branch, runner_path, settings, start };
    tauri::async_runtime::spawn_blocking(move || start_blocking(&app, req))
        .await
        .map_err(|e| format!("Could not start the runner: {e}"))?
}

#[tauri::command]
pub async fn stop_local_runner(state: State<'_, Runners>, thread_id: String) -> Result<(), String> {
    let proc = state.lock().remove(&thread_id);
    if let Some(p) = proc {
        tauri::async_runtime::spawn_blocking(move || stop(p))
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
            stop(p);
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
    // Instructions go in a file of their own per thread; the runner reads it when it starts.
    let instructions_path = match &req.settings.instructions {
        Some(text) => {
            let dir = app
                .path()
                .app_data_dir()
                .map_err(|e| format!("Could not find the app's data folder: {e}"))?
                .join("instructions");
            fs::create_dir_all(&dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
            let file = dir.join(format!("{}.md", req.thread_id));
            fs::write(&file, text).map_err(|e| format!("Could not save the instructions: {e}"))?;
            Some(file)
        }
        None => None,
    };

    let state = app.state::<Runners>();
    let (info, log_path) = {
        let mut runners = state.lock();

        if let Some(existing) = runners.get_mut(&req.thread_id) {
            if existing.alive() {
                let info = RunnerInfo { port: existing.port, secret: existing.secret.clone() };
                let log = existing.log_path.clone();
                drop(runners);
                wait_until_ready(app, &req.thread_id, info.port, &log, Probe::Tcp)?;
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
        // The user's agent plugins; the runner puts the enabled ones into the thread.
        if let Some(plugins) = crate::plugins::plugins_dir().filter(|d| d.is_dir()) {
            cmd.arg("--plugins-dir").arg(plugins);
        }
        if let Some(file) = &instructions_path {
            cmd.arg("--instructions-file").arg(file);
        }
        cmd.args(thread_flags(agent_command.as_deref(), req.model, req.reasoning, req.fast, req.base_branch, &req.settings));
        cmd.args(req.start.flags());
        // If this app crashes or is force-quit, the runner stops too instead of living on:
        // it notices its parent changing, and its stdin (held open below) closing.
        cmd.arg("--secret-stdin").arg("--exit-with-parent");
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
        cmd.env("PATH", paths::search_path())
            // Nothing this app was started with may stand in for the secret sent below.
            .env_remove("LEMONLIME_THREAD_SECRET")
            .env_remove("LEMONLIME_KEEPER")
            .env_remove("LEMONLIME_RUNNER_PORT")
            .current_dir(&workdir)
            .stdin(Stdio::piped())
            .stdout(Stdio::from(log))
            .stderr(Stdio::from(log_err));
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Could not start {}: {e}", program.display()))?;
        // The secret is the first line on the runner's stdin. A runner that has already
        // exited makes this fail; the wait below then reports why, from its log.
        let mut stdin = child.stdin.take();
        if let Some(pipe) = stdin.as_mut() {
            let _ = pipe.write_all(format!("{secret}\n").as_bytes()).and_then(|()| pipe.flush());
        }

        runners.insert(
            req.thread_id.clone(),
            RunnerProcess { child, port, secret: secret.clone(), log_path: log_path.clone(), stdin },
        );
        (RunnerInfo { port, secret }, log_path)
    };

    wait_until_ready(app, &req.thread_id, info.port, &log_path, Probe::Tcp)?;
    Ok(info)
}

/// How to tell a runner is ready.
#[derive(Clone, Copy)]
pub(crate) enum Probe<'a> {
    /// Something accepts connections on the port (a runner on this computer).
    Tcp,
    /// The runner on `host` answers /healthz for this thread through the port. An ssh tunnel
    /// accepts connections before the far end is there, so a connection alone proves nothing.
    Health { host: &'a str },
}

/// Waits until the runner is ready. Fails early if it exits.
/// If it is merely slow, returns Ok and lets the client keep retrying.
pub(crate) fn wait_until_ready(app: &AppHandle, thread_id: &str, port: u16, log_path: &Path, probe: Probe<'_>) -> Result<(), String> {
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let deadline = Instant::now() + match probe {
        Probe::Tcp => READY_TIMEOUT,
        // Connecting, then making the thread's worktree on the far side, takes longer.
        Probe::Health { .. } => READY_TIMEOUT * 3,
    };
    loop {
        let ready = match probe {
            Probe::Tcp => TcpStream::connect_timeout(&addr, Duration::from_millis(250)).is_ok(),
            Probe::Health { .. } => answers_health(&addr, thread_id),
        };
        if ready {
            return Ok(());
        }
        {
            let state = app.state::<Runners>();
            let mut runners = state.lock();
            let exited = match runners.get_mut(thread_id) {
                Some(p) => match p.child.try_wait() {
                    Ok(Some(status)) => Some((status.to_string(), status.code())),
                    Ok(None) => None,
                    Err(e) => Some((e.to_string(), None)),
                },
                // Stopped by someone else meanwhile.
                None => return Err("The runner was stopped.".into()),
            };
            if let Some((status, code)) = exited {
                runners.remove(thread_id);
                drop(runners);
                let tail = log_tail(log_path);
                return Err(match probe {
                    Probe::Health { host } => crate::ssh::explain_failure(host, code, &tail),
                    Probe::Tcp if tail.is_empty() => format!("The runner exited right away ({status})."),
                    Probe::Tcp => format!("The runner exited right away ({status}):\n{tail}"),
                });
            }
        }
        if Instant::now() >= deadline {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(150));
    }
}

/// GET /healthz through the port; true when the runner for this thread answers.
fn answers_health(addr: &SocketAddr, thread_id: &str) -> bool {
    let Ok(mut stream) = TcpStream::connect_timeout(addr, Duration::from_millis(500)) else { return false };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(3)));
    if stream.write_all(b"GET /healthz HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n").is_err() {
        return false;
    }
    let mut buf = Vec::new();
    let _ = stream.take(16 * 1024).read_to_end(&mut buf);
    let text = String::from_utf8_lossy(&buf);
    text.starts_with("HTTP/1.1 200") && text.contains(&format!("\"threadId\":\"{thread_id}\""))
}

/// Stops a runner. Closing its stdin first lets it stop cleanly (it stops when its stdin
/// closes), which for one on another machine also ends the ssh session; a runner still
/// there after a while is ended the hard way.
pub(crate) fn stop(p: RunnerProcess) {
    let RunnerProcess { mut child, stdin, .. } = p;
    if let Some(stdin) = stdin {
        drop(stdin);
        let deadline = Instant::now() + STOP_GRACE + STOP_GRACE;
        while Instant::now() < deadline {
            if matches!(child.try_wait(), Ok(Some(_))) {
                return;
            }
            thread::sleep(Duration::from_millis(100));
        }
    }
    terminate(child);
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

pub(crate) fn valid_thread_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    (6..=64).contains(&bytes.len())
        && bytes[0].is_ascii_alphanumeric()
        && bytes.iter().all(|b| b.is_ascii_digit() || b.is_ascii_lowercase() || *b == b'-')
}

pub(crate) fn non_empty(v: Option<String>) -> Option<String> {
    v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// 32 random bytes, hex encoded.
pub(crate) fn random_secret() -> String {
    let bytes: [u8; 32] = rand::random();
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Asks the OS for a free port on the loopback interface.
pub(crate) fn free_port() -> Result<u16, String> {
    TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .map_err(|e| format!("Could not find a free port: {e}"))
}

pub(crate) fn open_log(path: &Path) -> Result<File, String> {
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
