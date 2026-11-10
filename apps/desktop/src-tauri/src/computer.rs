//! What a cloud agent may do on this computer: each thread's setting is kept and checked
//! here, and the person is asked in a native dialog when it says to. Paths must be absolute
//! and are never followed through symlinks, so a link can't point a read somewhere else.

use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

const MAX_READ: u64 = 1024 * 1024;
const MAX_OUTPUT: usize = 256 * 1024;
const COMMAND_TIMEOUT: Duration = Duration::from_secs(60);
/// A request longer than this can't be read in a dialog, so it is refused rather than asked.
const MAX_ASK_CHARS: usize = 2000;
/// How many questions may wait behind the one on screen.
const MAX_WAITING: usize = 3;
/// After a "no", how long a thread waits before it can ask again.
const AFTER_NO: Duration = Duration::from_secs(10);
/// An "allow" this soon after the dialog opened was a click meant for something else.
const TOO_FAST: Duration = Duration::from_millis(500);
/// No console window for helper processes (Windows).
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// An absolute path with no `..`, no part of which is a symlink.
fn safe_path(path: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(path);
    if !p.is_absolute() {
        return Err("Give an absolute path.".into());
    }
    if p.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err("Paths with .. aren't allowed.".into());
    }
    // On Windows, ordinary drive paths only (C:\…). A network share would send this computer's
    // sign-in to another machine, and a device path reaches things that aren't files.
    if p.components().any(|c| matches!(c, Component::Prefix(prefix) if !matches!(prefix.kind(), std::path::Prefix::Disk(_)))) {
        return Err("Only paths on this computer's own drives are allowed.".into());
    }
    let mut so_far = PathBuf::new();
    for c in p.components() {
        so_far.push(c);
        if matches!(c, Component::RootDir | Component::Prefix(_)) {
            continue;
        }
        let meta = fs::symlink_metadata(&so_far).map_err(|e| format!("{}: {e}", so_far.display()))?;
        if meta.file_type().is_symlink() {
            return Err(format!("{} is a symbolic link; links aren't followed.", so_far.display()));
        }
    }
    Ok(p)
}

fn read_file_at(path: &str) -> Result<String, String> {
    let p = safe_path(path)?;
    let meta = fs::symlink_metadata(&p).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("That isn't a file.".into());
    }
    let mut buf = Vec::new();
    fs::File::open(&p).map_err(|e| e.to_string())?.take(MAX_READ).read_to_end(&mut buf).map_err(|e| e.to_string())?;
    let mut text = String::from_utf8_lossy(&buf).into_owned();
    if meta.len() > MAX_READ {
        text.push_str(&format!("\n[… cut at 1 MB of {} bytes]", meta.len()));
    }
    Ok(text)
}

fn list_dir_at(path: &str) -> Result<String, String> {
    let p = safe_path(path)?;
    let mut rows: Vec<String> = fs::read_dir(&p)
        .map_err(|e| e.to_string())?
        .flatten()
        .take(2000)
        .map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            match e.metadata() {
                _ if e.file_type().map(|t| t.is_symlink()).unwrap_or(false) => format!("link  {name}"),
                Ok(m) if m.is_dir() => format!("dir   {name}/"),
                Ok(m) => format!("file  {name}  ({} bytes)", m.len()),
                Err(_) => format!("?     {name}"),
            }
        })
        .collect();
    rows.sort();
    Ok(rows.join("\n"))
}

fn home() -> PathBuf {
    #[cfg(windows)]
    let h = std::env::var_os("USERPROFILE");
    #[cfg(not(windows))]
    let h = std::env::var_os("HOME");
    h.map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/"))
}

/// Output read from a pipe on its own thread, keeping the first MAX_OUTPUT bytes.
struct Collected {
    buf: Arc<Mutex<Vec<u8>>>,
    done: mpsc::Receiver<()>,
}

impl Collected {
    /// What was read, once the pipe closed or after a short wait: a background process the
    /// command started may hold the pipe open long after the command itself is done.
    fn finish(self) -> Vec<u8> {
        let _ = self.done.recv_timeout(Duration::from_millis(500));
        std::mem::take(&mut *self.buf.lock().unwrap_or_else(|e| e.into_inner()))
    }
}

fn collect<R: Read + Send + 'static>(pipe: Option<R>) -> Collected {
    let buf = Arc::new(Mutex::new(Vec::new()));
    let (tx, done) = mpsc::channel();
    let keep = buf.clone();
    thread::spawn(move || {
        if let Some(mut p) = pipe {
            let mut chunk = [0u8; 8192];
            while let Ok(n) = p.read(&mut chunk) {
                if n == 0 {
                    break;
                }
                let mut b = keep.lock().unwrap_or_else(|e| e.into_inner());
                let room = MAX_OUTPUT.saturating_sub(b.len());
                b.extend_from_slice(&chunk[..n.min(room)]);
            }
        }
        let _ = tx.send(());
    });
    Collected { buf, done }
}

/// Stops the command and anything left in its process group.
fn stop_group(child: &mut std::process::Child) {
    #[cfg(unix)]
    {
        let _ = Command::new("kill").arg("-KILL").arg("--").arg(format!("-{}", child.id())).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status();
    }
    // Windows has no process groups to signal: while the command is still going (a timeout),
    // take down everything it started along with it.
    #[cfg(windows)]
    if matches!(child.try_wait(), Ok(None)) {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("taskkill")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let _ = child.kill();
}

async fn run_command_at(command: String, cwd: Option<String>) -> Result<String, String> {
    let dir = match cwd.filter(|c| !c.is_empty()) {
        Some(c) => safe_path(&c)?,
        None => home(),
    };
    if !Path::new(&dir).is_dir() {
        return Err("That folder doesn't exist.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        // cmd has quoting rules of its own, so it gets the line exactly as written: with /S it
        // drops the outer pair of quotes and runs what is between them.
        #[cfg(windows)]
        let mut cmd = {
            use std::os::windows::process::CommandExt;
            let mut c = Command::new("cmd");
            c.raw_arg(format!("/S /C \"{command}\""));
            c.creation_flags(CREATE_NO_WINDOW);
            c
        };
        #[cfg(not(windows))]
        let mut cmd = {
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
            let mut c = Command::new(shell);
            c.arg("-lc").arg(&command);
            c
        };
        // Its own process group (Unix), so a timeout also stops what it started.
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }
        let mut child = cmd
            .current_dir(&dir)
            .env("PATH", crate::paths::search_path())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Couldn't run it: {e}"))?;
        // Both streams are read at once, so a command filling one can't stall on the other;
        // past the limit, output is read and dropped rather than left to block the command.
        let stdout = collect(child.stdout.take());
        let stderr = collect(child.stderr.take());
        let started = Instant::now();
        let status = loop {
            match child.try_wait() {
                Ok(Some(s)) => break Some(s),
                Ok(None) if started.elapsed() < COMMAND_TIMEOUT => thread::sleep(Duration::from_millis(25)),
                _ => break None,
            }
        };
        // Whatever it left running in the background goes too (and on a timeout, all of it).
        stop_group(&mut child);
        let _ = child.wait();
        let mut text = String::from_utf8_lossy(&stdout.finish()).into_owned();
        text.push_str(&String::from_utf8_lossy(&stderr.finish()));
        if text.len() > MAX_OUTPUT {
            let mut cut = MAX_OUTPUT;
            while !text.is_char_boundary(cut) {
                cut -= 1;
            }
            text.truncate(cut);
        }
        match status {
            None => text.push_str("\n[stopped after 60 seconds]"),
            Some(s) if !s.success() => text.push_str(&format!("\n[exit status {}]", s.code().map_or("?".into(), |c| c.to_string()))),
            _ => {}
        }
        Ok(text)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Whether a file usually holds keys, tokens or passwords, going by where it is and what it
/// is called. Reading one is always put to the person first, short of full access.
fn holds_secrets(path: &Path) -> bool {
    const FOLDERS: &[&str] = &[".ssh", ".aws", ".gnupg", ".kube", ".docker", ".azure", ".password-store", "keychains"];
    const FOLDER_PAIRS: &[(&str, &str)] = &[(".config", "gh"), (".config", "gcloud"), (".lemonlime", "accounts")];
    const NAMES: &[&str] = &[
        ".netrc",
        "_netrc",
        ".npmrc",
        ".pypirc",
        ".pgpass",
        ".my.cnf",
        ".git-credentials",
        ".credentials.json",
        "credentials.json",
        "credentials",
        "auth.json",
        ".claude.json",
        "id_rsa",
        "id_dsa",
        "id_ecdsa",
        "id_ed25519",
        "login data",
        "cookies",
        "cookies.sqlite",
        "logins.json",
        "key4.db",
        "wallet.dat",
    ];
    const ENDINGS: &[&str] = &[".pem", ".key", ".p12", ".pfx", ".keystore", ".jks", ".kdbx", ".ppk"];
    const HARMLESS_ENV: &[&str] = &[".example", ".sample", ".template"];

    let parts: Vec<String> = path
        .components()
        .filter_map(|c| match c {
            Component::Normal(s) => Some(s.to_string_lossy().to_lowercase()),
            _ => None,
        })
        .collect();
    let Some((name, folders)) = parts.split_last() else { return false };
    let name = name.as_str();
    folders.iter().any(|f| FOLDERS.contains(&f.as_str()))
        || parts.windows(2).any(|w| FOLDER_PAIRS.contains(&(w[0].as_str(), w[1].as_str())))
        || NAMES.contains(&name)
        || ENDINGS.iter().any(|e| name.ends_with(e))
        || name == ".env"
        || (name.starts_with(".env.") && !HARMLESS_ENV.iter().any(|e| name.ends_with(e)))
        // Shell and database history: what was typed, passwords included.
        || (name.starts_with('.') && name.ends_with("_history"))
        // A running program's environment (Linux).
        || (name == "environ" && parts.first().is_some_and(|p| p == "proc"))
}

// ── Who may do what ──────────────────────────────────────────────────────────
//
// Each cloud thread's level of access to this computer is kept here and checked here before
// every request, whatever the window sent. Raising a level and each "ask first" request are
// put to the person in a native dialog, which a page in the window can't click. That guards
// against a slip in the window's code and against an agent that asks for more than it was
// given; it is not a wall around the window, which can already start local agents and
// terminals on this computer.

/// A thread's access, lowest to highest.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
enum Level {
    Off,
    Read,
    Ask,
    Full,
}

impl Level {
    fn parse(s: &str) -> Option<Level> {
        match s {
            "off" => Some(Level::Off),
            "read" => Some(Level::Read),
            "ask" => Some(Level::Ask),
            "full" => Some(Level::Full),
            _ => None,
        }
    }
    fn name(self) -> &'static str {
        match self {
            Level::Off => "off",
            Level::Read => "read",
            Level::Ask => "ask",
            Level::Full => "full",
        }
    }
    fn describe(self) -> &'static str {
        match self {
            Level::Off => "no access to this computer",
            Level::Read => "read files and list folders on this computer (it still asks before files that usually hold keys or passwords)",
            Level::Ask => "ask you before each request on this computer",
            Level::Full => "read files, list folders and run commands on this computer without asking",
        }
    }
}

#[derive(Default)]
pub struct ComputerAccess {
    levels: Mutex<Option<HashMap<String, String>>>,
    /// Held while a question is on screen, so there is only ever one.
    asking: tauri::async_runtime::Mutex<()>,
    /// How many questions are waiting for that turn.
    waiting: AtomicUsize,
    /// When each thread was last told no.
    refused: Mutex<HashMap<String, Instant>>,
}

fn access_file() -> Option<PathBuf> {
    crate::skills::user_skills_dir().and_then(|d| d.parent().map(|p| p.join("computer-access.json")))
}

fn valid_thread_id(id: &str) -> bool {
    (6..=64).contains(&id.len()) && id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-') && !id.starts_with('-')
}

impl ComputerAccess {
    fn with<T>(&self, f: impl FnOnce(&mut HashMap<String, String>) -> T) -> T {
        let mut guard = self.levels.lock().unwrap_or_else(|e| e.into_inner());
        let map = guard.get_or_insert_with(|| {
            access_file()
                .and_then(|f| fs::read_to_string(f).ok())
                .and_then(|t| serde_json::from_str::<HashMap<String, String>>(&t).ok())
                .unwrap_or_default()
                .into_iter()
                .filter(|(k, v)| valid_thread_id(k) && Level::parse(v).is_some())
                .collect()
        });
        f(map)
    }

    fn level(&self, thread_id: &str) -> Level {
        self.with(|m| m.get(thread_id).and_then(|v| Level::parse(v)).unwrap_or(Level::Off))
    }

    fn set(&self, thread_id: &str, level: Level) -> Result<(), String> {
        self.with(|m| {
            if level == Level::Off {
                m.remove(thread_id);
            } else {
                m.insert(thread_id.to_string(), level.name().to_string());
            }
            let Some(file) = access_file() else { return Ok(()) };
            if let Some(dir) = file.parent() {
                fs::create_dir_all(dir).map_err(|e| e.to_string())?;
            }
            let tmp = file.with_extension("json.tmp");
            fs::write(&tmp, serde_json::to_string_pretty(m).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
            fs::rename(&tmp, &file).map_err(|e| e.to_string())
        })
    }

    /// Whether the person said no to this thread a moment ago.
    fn just_refused(&self, thread_id: &str) -> bool {
        let mut refused = self.refused.lock().unwrap_or_else(|e| e.into_inner());
        refused.retain(|_, at| at.elapsed() < AFTER_NO);
        refused.contains_key(thread_id)
    }

    fn note_refusal(&self, thread_id: &str) {
        self.refused.lock().unwrap_or_else(|e| e.into_inner()).insert(thread_id.to_string(), Instant::now());
    }
}

/// A string shown exactly as it is: control and invisible characters, and anything outside
/// plain ASCII, are written as escapes, so look-alike letters can't disguise what will run.
fn shown_exactly(s: &str) -> String {
    let mut out = String::new();
    for ch in s.chars() {
        match ch {
            '\n' => out.push_str("\\n"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 || c as u32 == 0x7f => out.push_str(&format!("\\x{:02x}", c as u32)),
            c if (c as u32) > 0x7e => out.push_str(&format!("\\u{{{:x}}}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

const DONT_ALLOW: &str = "Don't allow";

/// Only a click on the allow button is a yes. Whatever else a dialog can come back with (the
/// other buttons, Escape, a closed window, a platform's stock answers) is a no.
fn said_yes(answer: &tauri_plugin_dialog::MessageDialogResult, allow: &str) -> bool {
    allow != DONT_ALLOW && matches!(answer, tauri_plugin_dialog::MessageDialogResult::Custom(label) if label == allow)
}

/// Asks in a native dialog, which a page in the window can't answer for the person. "Don't
/// allow" comes first, so it is the button Return presses.
fn confirm(app: &tauri::AppHandle, title: &str, message: &str, allow: &str) -> bool {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    for _ in 0..2 {
        let opened = Instant::now();
        let answer = app
            .dialog()
            .message(message)
            .title(title)
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::YesNoCancelCustom(DONT_ALLOW.to_string(), allow.to_string(), "Cancel".to_string()))
            .blocking_show_with_result();
        if !said_yes(&answer, allow) {
            return false;
        }
        // Too quick to be an answer: the dialog opened under a click meant for something else. Ask again.
        if opened.elapsed() >= TOO_FAST {
            return true;
        }
    }
    false
}

/// What a thread's level means for one request: refused, allowed outright (`None`), or the
/// question to put to the person first.
fn verdict(level: Level, runs: bool, secret: bool, what: &str) -> Result<Option<String>, String> {
    match level {
        Level::Off => Err("The user hasn't given this thread access to their computer.".into()),
        Level::Read if runs => Err("Not allowed: this thread can only read files and list folders.".into()),
        Level::Full => Ok(None),
        Level::Read if !secret => Ok(None),
        Level::Read | Level::Ask => {
            if what.chars().count() > MAX_ASK_CHARS {
                return Err("Too long to show the user in full (over 2,000 characters). Ask in smaller steps.".into());
            }
            let warning = if secret { "\n\nThis file usually holds keys or passwords." } else { "" };
            Ok(Some(format!("A cloud agent wants to:\n\n{what}{warning}\n\nAllow it once?")))
        }
    }
}

/// One place in the line for the dialog, given back when dropped.
struct Waiting<'a>(&'a AtomicUsize);

impl<'a> Waiting<'a> {
    fn join(count: &'a AtomicUsize) -> Option<Self> {
        if count.fetch_add(1, Ordering::SeqCst) >= MAX_WAITING {
            count.fetch_sub(1, Ordering::SeqCst);
            return None;
        }
        Some(Waiting(count))
    }
}

impl Drop for Waiting<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Every cloud thread's level, for the window to show.
#[tauri::command]
pub fn computer_access_levels(state: tauri::State<'_, ComputerAccess>) -> HashMap<String, String> {
    state.with(|m| m.clone())
}

/// Change a thread's level. Lowering it always works; raising it needs the person's OK in a
/// native dialog. Returns the level now in force.
#[tauri::command]
pub async fn computer_set_access(app: tauri::AppHandle, state: tauri::State<'_, ComputerAccess>, thread_id: String, level: String) -> Result<String, String> {
    if !valid_thread_id(&thread_id) {
        return Err("That isn't a thread.".into());
    }
    let next = Level::parse(&level).ok_or("That isn't an access level.")?;
    if next > state.level(&thread_id) {
        let _turn = state.asking.lock().await;
        // Read again: it may have changed while another question was on screen.
        let now = state.level(&thread_id);
        if next > now {
            let question = format!("Let the cloud agent in this thread {}?", next.describe());
            let app2 = app.clone();
            let ok = tauri::async_runtime::spawn_blocking(move || confirm(&app2, "Access to this computer", &question, "Allow"))
                .await
                .map_err(|e| e.to_string())?;
            if !ok {
                return Ok(now.name().to_string());
            }
        }
    }
    state.set(&thread_id, next)?;
    Ok(next.name().to_string())
}

/// Checks the thread's level for a request, asking in a native dialog when it says to. There
/// is only ever one question on screen; a few more may wait their turn, and a thread that
/// was just told no can't ask again straight away.
async fn allowed(app: &tauri::AppHandle, state: &ComputerAccess, thread_id: &str, runs: bool, secret: bool, what: String) -> Result<(), String> {
    const JUST_SAID_NO: &str = "The user said no a moment ago. Wait a little before asking again.";
    if verdict(state.level(thread_id), runs, secret, &what)?.is_none() {
        return Ok(());
    }
    if state.just_refused(thread_id) {
        return Err(JUST_SAID_NO.into());
    }
    let Some(place) = Waiting::join(&state.waiting) else {
        return Err("Too many requests are already waiting for the user's answer.".into());
    };
    let _turn = state.asking.lock().await;
    drop(place);
    // The setting may have changed, or the person may have said no, while this one waited.
    let Some(message) = verdict(state.level(thread_id), runs, secret, &what)? else {
        return Ok(());
    };
    if state.just_refused(thread_id) {
        return Err(JUST_SAID_NO.into());
    }
    let app2 = app.clone();
    let ok = tauri::async_runtime::spawn_blocking(move || confirm(&app2, "A cloud agent is asking", &message, "Allow once"))
        .await
        .map_err(|e| e.to_string())?;
    if ok {
        Ok(())
    } else {
        state.note_refusal(thread_id);
        Err("The user said no.".into())
    }
}

/// File work, off the threads that keep the window responsive.
async fn off_thread(work: impl FnOnce() -> Result<String, String> + Send + 'static) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(work).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn computer_read_file(app: tauri::AppHandle, state: tauri::State<'_, ComputerAccess>, thread_id: String, path: String) -> Result<String, String> {
    let secret = holds_secrets(Path::new(&path));
    allowed(&app, &state, &thread_id, false, secret, format!("Read the file {}", shown_exactly(&path))).await?;
    off_thread(move || read_file_at(&path)).await
}

#[tauri::command]
pub async fn computer_list_dir(app: tauri::AppHandle, state: tauri::State<'_, ComputerAccess>, thread_id: String, path: String) -> Result<String, String> {
    allowed(&app, &state, &thread_id, false, false, format!("List the folder {}", shown_exactly(&path))).await?;
    off_thread(move || list_dir_at(&path)).await
}

#[tauri::command]
pub async fn computer_run_command(
    app: tauri::AppHandle,
    state: tauri::State<'_, ComputerAccess>,
    thread_id: String,
    command: String,
    cwd: Option<String>,
) -> Result<String, String> {
    let place = match cwd.as_deref().filter(|c| !c.is_empty()) {
        Some(c) => format!(" in {}", shown_exactly(c)),
        None => " in your home folder".into(),
    };
    allowed(&app, &state, &thread_id, true, false, format!("Run this command{place}:\n\n{}", shown_exactly(&command))).await?;
    run_command_at(command, cwd).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn access_levels_order_and_names() {
        assert!(Level::Off < Level::Read && Level::Read < Level::Ask && Level::Ask < Level::Full);
        for l in [Level::Off, Level::Read, Level::Ask, Level::Full] {
            assert_eq!(Level::parse(l.name()), Some(l));
        }
        assert_eq!(Level::parse("root"), None);
        assert!(valid_thread_id("thread-abc123"));
        assert!(!valid_thread_id("../etc"));
        assert!(!valid_thread_id("-abcdef"));
    }

    #[test]
    fn only_a_click_on_allow_is_a_yes() {
        use tauri_plugin_dialog::MessageDialogResult as R;
        assert!(said_yes(&R::Custom("Allow once".into()), "Allow once"));
        // Return presses "Don't allow"; Escape and closing the dialog come back as "Cancel".
        for no in [R::Custom(DONT_ALLOW.into()), R::Custom("Cancel".into()), R::Custom("Allow".into()), R::Ok, R::Yes, R::No, R::Cancel] {
            assert!(!said_yes(&no, "Allow once"), "{no:?}");
        }
        assert!(!said_yes(&R::Custom(DONT_ALLOW.into()), DONT_ALLOW));
    }

    #[test]
    fn each_level_refuses_allows_or_asks() {
        let read = "Read the file /tmp/notes.txt";
        assert!(verdict(Level::Off, false, false, read).is_err());
        assert_eq!(verdict(Level::Read, false, false, read), Ok(None));
        assert!(verdict(Level::Read, true, false, "Run this command").unwrap_err().contains("only read"));
        assert_eq!(verdict(Level::Full, true, false, "Run this command"), Ok(None));
        assert_eq!(verdict(Level::Full, false, true, read), Ok(None));
        assert!(verdict(Level::Ask, false, false, read).unwrap().unwrap().contains(read));
        // Files that hold keys are asked about even when reading is allowed.
        let asked = verdict(Level::Read, false, true, "Read the file /home/me/.ssh/id_ed25519").unwrap().unwrap();
        assert!(asked.contains("keys or passwords") && asked.contains("id_ed25519"));
        assert!(verdict(Level::Ask, false, true, read).unwrap().unwrap().contains("keys or passwords"));
        // Nothing too long to read is ever asked.
        let long = "x".repeat(MAX_ASK_CHARS + 1);
        assert!(verdict(Level::Ask, true, false, &long).unwrap_err().contains("Too long"));
        assert!(verdict(Level::Ask, true, false, &"x".repeat(MAX_ASK_CHARS)).unwrap().is_some());
        assert_eq!(verdict(Level::Full, true, false, &long), Ok(None));
    }

    #[test]
    fn knows_the_files_that_hold_keys_and_passwords() {
        for secret in [
            "/Users/me/.ssh/id_ed25519",
            "/Users/me/.ssh/config",
            "/home/me/.aws/credentials",
            "/home/me/.config/gh/hosts.yml",
            "/home/me/.lemonlime/accounts/work/auth.json",
            "/Users/me/Library/Keychains/login.keychain-db",
            "/Users/me/.netrc",
            "/Users/me/.zsh_history",
            "/Users/me/code/app/.env",
            "/Users/me/code/app/.ENV.production",
            "/Users/me/code/app/certs/server.KEY",
            "/Users/me/.claude/.credentials.json",
            "/Users/me/.codex/auth.json",
            "/proc/1/environ",
            "C:\\Users\\me\\.ssh\\id_rsa",
        ] {
            // Windows-style paths only split into parts on Windows.
            if secret.contains('\\') && !cfg!(windows) {
                continue;
            }
            assert!(holds_secrets(Path::new(secret)), "{secret}");
        }
        for plain in [
            "/Users/me/code/app/README.md",
            "/Users/me/code/app/.env.example",
            "/Users/me/code/app/src/keyboard.ts",
            "/Users/me/code/app/order_history",
            "/Users/me/.config/git/config",
            "/Users/me/code/environ",
            "/",
        ] {
            assert!(!holds_secrets(Path::new(plain)), "{plain}");
        }
    }

    #[test]
    fn only_a_few_questions_wait_and_a_no_holds_for_a_while() {
        let count = AtomicUsize::new(0);
        let held: Vec<_> = (0..MAX_WAITING).map(|_| Waiting::join(&count).expect("room")).collect();
        assert!(Waiting::join(&count).is_none());
        drop(held);
        assert_eq!(count.load(Ordering::SeqCst), 0);
        assert!(Waiting::join(&count).is_some());

        let access = ComputerAccess::default();
        assert!(!access.just_refused("thread-abc123"));
        access.note_refusal("thread-abc123");
        assert!(access.just_refused("thread-abc123"));
        assert!(!access.just_refused("thread-other1"));
        access.refused.lock().unwrap().insert("thread-abc123".into(), Instant::now() - AFTER_NO);
        assert!(!access.just_refused("thread-abc123"));
    }

    #[test]
    fn shows_hidden_characters_in_what_it_asks_about() {
        assert_eq!(shown_exactly("rm -rf ~/x"), "rm -rf ~/x");
        assert_eq!(shown_exactly("ls\u{202e}txt.exe\n"), "ls\\u{202e}txt.exe\\n");
        assert_eq!(shown_exactly("a\u{0}b"), "a\\x00b");
    }

    #[cfg(unix)]
    #[test]
    fn lots_of_error_output_doesnt_stall_and_background_jobs_are_stopped() {
        let started = Instant::now();
        // 300 KB on stderr (more than a pipe holds), then a background job that keeps the pipes open.
        let out = tauri::async_runtime::block_on(run_command_at(
            "head -c 300000 /dev/zero | tr '\\0' e 1>&2; sleep 300 & echo bg=$!".into(),
            None,
        ))
        .unwrap();
        assert!(started.elapsed() < Duration::from_secs(10), "took {:?}", started.elapsed());
        assert!(out.contains("bg="), "{}", &out[..out.len().min(200)]);
        assert!(out.len() <= MAX_OUTPUT + 64);
        let pid: u32 = out.split("bg=").nth(1).unwrap().split_whitespace().next().unwrap().parse().unwrap();
        let alive = Command::new("kill").arg("-0").arg(pid.to_string()).stderr(Stdio::null()).status().unwrap().success();
        assert!(!alive, "the background job should have been stopped");
    }

    #[test]
    fn refuses_relative_dotdot_and_links() {
        assert!(safe_path("notes.txt").is_err());
        assert!(safe_path("/tmp/../etc/passwd").is_err());
        // macOS's temp folder sits behind a link (/var → /private/var), which the checks refuse; use its real path.
        let dir = fs::canonicalize(std::env::temp_dir()).unwrap().join(format!("lemonlime-computer-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let real = dir.join("real.txt");
        fs::write(&real, "hi").unwrap();
        assert_eq!(read_file_at(&real.to_string_lossy()).unwrap(), "hi");
        #[cfg(unix)]
        {
            let link = dir.join("link.txt");
            std::os::unix::fs::symlink(&real, &link).unwrap();
            assert!(read_file_at(&link.to_string_lossy()).unwrap_err().contains("symbolic link"));
            assert!(list_dir_at(&dir.to_string_lossy()).unwrap().contains("link  link.txt"));
        }
        fs::remove_dir_all(&dir).unwrap();
    }
}
