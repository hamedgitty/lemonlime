//! This computer: which agent CLIs are installed (and installing or updating them),
//! keeping the computer awake while agents work, and opening folders in an editor.

use serde::Serialize;
use std::path::PathBuf;
#[cfg(not(windows))]
use std::process::Child;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::sync::Mutex;
use std::thread;
use std::time::Duration;
use tauri::State;

use crate::paths;
use crate::runner::Runners;

// ── Agent CLIs ───────────────────────────────────────────────

struct AgentCli {
    kind: &'static str,
    program: &'static str,
    /// npm package that installs it (the documented way for all three).
    package: &'static str,
}

const AGENT_CLIS: &[AgentCli] = &[
    AgentCli { kind: "claude-code", program: "claude", package: "@anthropic-ai/claude-code" },
    AgentCli { kind: "codex", program: "codex", package: "@openai/codex" },
    AgentCli { kind: "opencode", program: "opencode", package: "opencode-ai" },
];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInstall {
    kind: &'static str,
    installed: bool,
    path: Option<String>,
    /// The version the CLI reports, e.g. "2.1.302".
    version: Option<String>,
    /// Signed in, as far as can be told without reading any credential: None when unknown.
    signed_in: Option<bool>,
}

/// Runs a program with a time limit; returns (exit ok, stdout + stderr).
fn run_with_timeout(mut cmd: Command, timeout: Duration) -> Option<(bool, String)> {
    cmd.env("PATH", paths::search_path()).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let child = cmd.spawn().ok()?;
    let pid = child.id();
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let _ = tx.send(child.wait_with_output());
    });
    match rx.recv_timeout(timeout) {
        Ok(Ok(out)) => {
            let mut text = String::from_utf8_lossy(&out.stdout).to_string();
            text.push_str(&String::from_utf8_lossy(&out.stderr));
            Some((out.status.success(), text))
        }
        _ => {
            kill(pid);
            None
        }
    }
}

fn kill(pid: u32) {
    #[cfg(unix)]
    unsafe {
        libc::kill(pid as libc::pid_t, libc::SIGKILL);
    }
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill").args(["/PID", &pid.to_string(), "/T", "/F"]).output();
    }
}

/// On Windows npm installs `.cmd` shims, which must be run through the shell.
fn program_command(path: &PathBuf) -> Command {
    #[cfg(windows)]
    {
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
        if ext == "cmd" || ext == "bat" {
            let mut c = Command::new("cmd");
            c.arg("/C").arg(path);
            return c;
        }
    }
    Command::new(path)
}

/// The first thing that looks like a version number.
fn parse_version(text: &str) -> Option<String> {
    text.split(|c: char| c.is_whitespace() || c == '(' || c == ')' || c == ',')
        .map(|w| w.trim_start_matches('v'))
        .find(|w| {
            let parts: Vec<&str> = w.split('.').collect();
            parts.len() >= 2 && parts.iter().take(3).all(|p| !p.is_empty() && p.chars().next().is_some_and(|c| c.is_ascii_digit()))
        })
        .map(|w| w.to_string())
}

fn home() -> Option<PathBuf> {
    #[cfg(windows)]
    let h = std::env::var_os("USERPROFILE");
    #[cfg(not(windows))]
    let h = std::env::var_os("HOME");
    h.filter(|v| !v.is_empty()).map(PathBuf::from)
}

/// Whether the agent has a sign-in on this computer. Only checks that one exists;
/// never reads it.
fn signed_in(kind: &str, path: &PathBuf) -> Option<bool> {
    match kind {
        "claude-code" => {
            if std::env::var_os("ANTHROPIC_API_KEY").is_some() {
                return Some(true);
            }
            if home().is_some_and(|h| h.join(".claude").join(".credentials.json").is_file()) {
                return Some(true);
            }
            #[cfg(target_os = "macos")]
            {
                // The keychain item's existence only (no -w, so the secret isn't read).
                let mut c = Command::new("/usr/bin/security");
                c.args(["find-generic-password", "-s", "Claude Code-credentials"]);
                return run_with_timeout(c, Duration::from_secs(5)).map(|(ok, _)| ok);
            }
            #[cfg(not(target_os = "macos"))]
            Some(false)
        }
        "codex" => {
            let mut c = program_command(path);
            c.args(["login", "status"]);
            run_with_timeout(c, Duration::from_secs(8)).map(|(ok, text)| ok && !text.to_lowercase().contains("not logged in"))
        }
        "opencode" => home().map(|h| h.join(".local").join("share").join("opencode").join("auth.json").is_file()),
        _ => None,
    }
}

fn detect_one(cli: &AgentCli) -> AgentInstall {
    let Some(path) = paths::find_program(cli.program) else {
        return AgentInstall { kind: cli.kind, installed: false, path: None, version: None, signed_in: None };
    };
    let mut c = program_command(&path);
    c.arg("--version");
    let version = run_with_timeout(c, Duration::from_secs(10)).and_then(|(_, text)| parse_version(&text));
    AgentInstall {
        kind: cli.kind,
        installed: true,
        path: Some(path.display().to_string()),
        version,
        signed_in: signed_in(cli.kind, &path),
    }
}

/// Which agent CLIs are installed here, their versions, and whether they're signed in.
#[tauri::command]
pub async fn detect_agents() -> Vec<AgentInstall> {
    tauri::async_runtime::spawn_blocking(|| {
        let handles: Vec<_> = AGENT_CLIS.iter().map(|cli| thread::spawn(move || detect_one(cli))).collect();
        handles.into_iter().filter_map(|h| h.join().ok()).collect()
    })
    .await
    .unwrap_or_default()
}

/// Installs or updates an agent CLI with npm (the documented install for all three).
/// Only these fixed commands can run, never anything the page passes in.
#[tauri::command]
pub async fn install_agent(kind: String) -> Result<String, String> {
    let cli = AGENT_CLIS.iter().find(|c| c.kind == kind).ok_or("Unknown agent.")?;
    let npm = paths::find_program("npm").ok_or("Installing agents needs npm (it comes with Node.js). Install Node.js from nodejs.org, then try again.")?;
    let package = format!("{}@latest", cli.package);
    tauri::async_runtime::spawn_blocking(move || {
        let mut c = program_command(&npm);
        c.args(["install", "-g", &package]);
        match run_with_timeout(c, Duration::from_secs(600)) {
            Some((true, text)) => Ok(tail(&text, 4000)),
            Some((false, text)) => Err(format!("npm couldn't install it:\n{}", tail(&text, 4000))),
            None => Err("Installing took longer than 10 minutes and was stopped.".into()),
        }
    })
    .await
    .map_err(|e| format!("Couldn't install: {e}"))?
}

fn tail(text: &str, max: usize) -> String {
    let t = text.trim();
    if t.len() <= max {
        return t.to_string();
    }
    let mut start = t.len() - max;
    while !t.is_char_boundary(start) {
        start += 1;
    }
    format!("…{}", &t[start..])
}

// ── Local thread status ──────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalStatus {
    thread_id: String,
    /// The runner's /healthz answer as it came (status, latestSeq, idleSince…).
    health: serde_json::Value,
}

fn healthz(port: u16) -> Option<serde_json::Value> {
    use std::io::{Read, Write};
    use std::net::{SocketAddr, TcpStream};
    let addr: SocketAddr = ([127, 0, 0, 1], port).into();
    let mut s = TcpStream::connect_timeout(&addr, Duration::from_millis(800)).ok()?;
    s.set_read_timeout(Some(Duration::from_secs(2))).ok()?;
    s.write_all(b"GET /healthz HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n").ok()?;
    let mut buf = Vec::new();
    s.take(64 * 1024).read_to_end(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf);
    let body = text.split("\r\n\r\n").nth(1)?;
    serde_json::from_str(body).ok()
}

/// What every runner on this computer is doing, so the app can notify about threads
/// that aren't open.
#[tauri::command]
pub async fn local_runner_statuses(state: State<'_, Runners>) -> Result<Vec<LocalStatus>, String> {
    let ports = state.ports();
    tauri::async_runtime::spawn_blocking(move || {
        ports.into_iter().filter_map(|(thread_id, port)| healthz(port).map(|health| LocalStatus { thread_id, health })).collect()
    })
    .await
    .map_err(|e| e.to_string())
}

// ── Keep awake ───────────────────────────────────────────────

/// What's holding the computer awake right now.
#[derive(Default)]
pub struct Awake(Mutex<Option<AwakeHold>>);

pub struct AwakeHold {
    display: bool,
    #[cfg(not(windows))]
    child: Child,
    #[cfg(windows)]
    stop: mpsc::Sender<()>,
}

impl AwakeHold {
    fn release(self) {
        #[cfg(not(windows))]
        {
            let mut child = self.child;
            let _ = child.kill();
            let _ = child.wait();
        }
        #[cfg(windows)]
        {
            let _ = self.stop.send(());
        }
    }
}

impl Awake {
    pub fn release(&self) {
        if let Some(hold) = self.0.lock().unwrap_or_else(|e| e.into_inner()).take() {
            hold.release();
        }
    }
}

#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn SetThreadExecutionState(flags: u32) -> u32;
}

fn hold_awake(display: bool) -> Result<AwakeHold, String> {
    #[cfg(target_os = "macos")]
    {
        // -i: no idle sleep; -d: display stays on too. Ends when we kill it (or the app exits: -w).
        let flags = if display { "-di" } else { "-i" };
        let child = Command::new("/usr/bin/caffeinate")
            .args([flags, "-w", &std::process::id().to_string()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("Couldn't keep the computer awake: {e}"))?;
        return Ok(AwakeHold { display, child });
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let inhibit = paths::find_program("systemd-inhibit").ok_or("Keeping awake needs systemd-inhibit, which isn't on this computer.")?;
        let what = if display { "idle:sleep" } else { "sleep" };
        let child = Command::new(inhibit)
            .args([&format!("--what={what}"), "--who=LemonLime", "--why=Agents are working", "sleep", "infinity"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("Couldn't keep the computer awake: {e}"))?;
        return Ok(AwakeHold { display, child });
    }
    #[cfg(windows)]
    {
        // The request lasts while the thread that made it is alive.
        const ES_CONTINUOUS: u32 = 0x8000_0000;
        const ES_SYSTEM_REQUIRED: u32 = 0x0000_0001;
        const ES_DISPLAY_REQUIRED: u32 = 0x0000_0002;
        let (tx, rx) = mpsc::channel::<()>();
        thread::spawn(move || {
            let flags = ES_CONTINUOUS | ES_SYSTEM_REQUIRED | if display { ES_DISPLAY_REQUIRED } else { 0 };
            unsafe {
                SetThreadExecutionState(flags);
            }
            let _ = rx.recv();
            unsafe {
                SetThreadExecutionState(ES_CONTINUOUS);
            }
        });
        return Ok(AwakeHold { display, stop: tx });
    }
}

/// Keep the computer from sleeping (on) or let it (off). `display` keeps the screen on too.
/// Closing a laptop's lid still sleeps it: that's the OS's call.
#[tauri::command]
pub fn set_keep_awake(state: State<'_, Awake>, on: bool, display: bool) -> Result<bool, String> {
    let mut slot = state.0.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(hold) = slot.as_ref() {
        if on && hold.display == display {
            return Ok(true);
        }
    }
    if let Some(hold) = slot.take() {
        hold.release();
    }
    if on {
        *slot = Some(hold_awake(display)?);
    }
    Ok(on)
}

// ── Editors ──────────────────────────────────────────────────

struct Editor {
    id: &'static str,
    name: &'static str,
    cli: &'static str,
    #[allow(dead_code)]
    mac_app: &'static str,
}

const EDITORS: &[Editor] = &[
    Editor { id: "vscode", name: "Visual Studio Code", cli: "code", mac_app: "Visual Studio Code" },
    Editor { id: "cursor", name: "Cursor", cli: "cursor", mac_app: "Cursor" },
    Editor { id: "windsurf", name: "Windsurf", cli: "windsurf", mac_app: "Windsurf" },
    Editor { id: "zed", name: "Zed", cli: "zed", mac_app: "Zed" },
    Editor { id: "sublime", name: "Sublime Text", cli: "subl", mac_app: "Sublime Text" },
    Editor { id: "idea", name: "IntelliJ IDEA", cli: "idea", mac_app: "IntelliJ IDEA" },
    Editor { id: "webstorm", name: "WebStorm", cli: "webstorm", mac_app: "WebStorm" },
    Editor { id: "xcode", name: "Xcode", cli: "xed", mac_app: "Xcode" },
];

#[derive(Serialize)]
pub struct EditorInfo {
    id: &'static str,
    name: &'static str,
}

#[cfg(target_os = "macos")]
fn mac_app_exists(app: &str) -> bool {
    let name = format!("{app}.app");
    PathBuf::from("/Applications").join(&name).is_dir() || home().is_some_and(|h| h.join("Applications").join(&name).is_dir())
}

fn editor_installed(e: &Editor) -> bool {
    #[cfg(target_os = "macos")]
    if mac_app_exists(e.mac_app) {
        return true;
    }
    paths::find_program(e.cli).is_some()
}

/// Code editors installed on this computer that a folder can be opened in.
#[tauri::command]
pub async fn list_editors() -> Vec<EditorInfo> {
    tauri::async_runtime::spawn_blocking(|| EDITORS.iter().filter(|e| editor_installed(e)).map(|e| EditorInfo { id: e.id, name: e.name }).collect())
        .await
        .unwrap_or_default()
}

/// Opens a folder or file in one of the editors above.
#[tauri::command]
pub fn open_in_editor(editor: String, path: String) -> Result<(), String> {
    let e = EDITORS.iter().find(|e| e.id == editor).ok_or("Unknown editor.")?;
    let target = PathBuf::from(&path);
    if !target.is_absolute() || !target.exists() {
        return Err(format!("{path} doesn't exist."));
    }
    #[cfg(target_os = "macos")]
    if mac_app_exists(e.mac_app) {
        return Command::new("/usr/bin/open")
            .args(["-a", e.mac_app])
            .arg(&target)
            .spawn()
            .map(|_| ())
            .map_err(|err| format!("Couldn't open {}: {err}", e.name));
    }
    let cli = paths::find_program(e.cli).ok_or_else(|| format!("{} isn't installed.", e.name))?;
    let mut c = program_command(&cli);
    c.arg(&target).env("PATH", paths::search_path()).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    c.spawn().map(|_| ()).map_err(|err| format!("Couldn't open {}: {err}", e.name))
}

/// Writes an export the person chose a place for in the save dialog. Only text exports,
/// never over an existing folder.
#[tauri::command]
pub fn save_text_file(path: String, content: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    let ext = target.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    if !target.is_absolute() || !["md", "json", "txt"].contains(&ext.as_str()) {
        return Err("Exports are saved as .md, .json or .txt files.".into());
    }
    if target.is_dir() {
        return Err("That's a folder.".into());
    }
    if content.len() > 200 * 1024 * 1024 {
        return Err("That export is too big.".into());
    }
    std::fs::write(&target, content).map_err(|e| format!("Couldn't save it: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_versions() {
        assert_eq!(parse_version("2.1.302 (Claude Code)").as_deref(), Some("2.1.302"));
        assert_eq!(parse_version("codex-cli 0.167.0").as_deref(), Some("0.167.0"));
        assert_eq!(parse_version("v1.18.18\n").as_deref(), Some("1.18.18"));
        assert_eq!(parse_version("no version here").as_deref(), None);
    }

    #[test]
    fn keeps_the_end_of_long_output() {
        let long = "x".repeat(5000) + "done";
        assert!(tail(&long, 10).ends_with("done"));
        assert_eq!(tail("short", 10), "short");
    }
}
