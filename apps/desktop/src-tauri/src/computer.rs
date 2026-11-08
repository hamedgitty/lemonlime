//! What a cloud agent may do on this computer, once the window has decided the thread's
//! setting allows it (and asked the user if it should). Paths must be absolute and are
//! never followed through symlinks, so a link can't point a read somewhere else.

use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::collections::HashMap;
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

const MAX_READ: u64 = 1024 * 1024;
const MAX_OUTPUT: usize = 256 * 1024;
const COMMAND_TIMEOUT: Duration = Duration::from_secs(60);

/// An absolute path with no `..`, no part of which is a symlink.
fn safe_path(path: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(path);
    if !p.is_absolute() {
        return Err("Give an absolute path.".into());
    }
    if p.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err("Paths with .. aren't allowed.".into());
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
        #[cfg(windows)]
        let mut cmd = {
            let mut c = Command::new("cmd");
            c.arg("/C").arg(&command);
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

// ── Who may do what ──────────────────────────────────────────────────────────
//
// Each cloud thread's level of access to this computer is kept here, in a file only the app
// writes, and checked here before every request: the window's own code can't grant itself
// more. Raising a level and each "ask first" request are confirmed in a native dialog.

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
            Level::Read => "read files and list folders on this computer",
            Level::Ask => "ask you before each request on this computer",
            Level::Full => "read files, list folders and run commands on this computer without asking",
        }
    }
}

#[derive(Default)]
pub struct ComputerAccess(Mutex<Option<HashMap<String, String>>>);

fn access_file() -> Option<PathBuf> {
    crate::skills::user_skills_dir().and_then(|d| d.parent().map(|p| p.join("computer-access.json")))
}

fn valid_thread_id(id: &str) -> bool {
    (6..=64).contains(&id.len()) && id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-') && !id.starts_with('-')
}

impl ComputerAccess {
    fn with<T>(&self, f: impl FnOnce(&mut HashMap<String, String>) -> T) -> T {
        let mut guard = self.0.lock().unwrap_or_else(|e| e.into_inner());
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

/// Asks in a native dialog, which the window's own code can't answer for the person.
fn confirm(app: &tauri::AppHandle, title: &str, message: &str, yes: &str) -> bool {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    app.dialog()
        .message(message)
        .title(title)
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(yes.to_string(), "Don't allow".to_string()))
        .blocking_show()
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
    state.set(&thread_id, next)?;
    Ok(next.name().to_string())
}

/// Checks the thread's level for a request, asking in a native dialog at "ask first".
async fn allowed(app: &tauri::AppHandle, state: &ComputerAccess, thread_id: &str, runs: bool, what: String) -> Result<(), String> {
    match state.level(thread_id) {
        Level::Off => Err("The user hasn't given this thread access to their computer.".into()),
        Level::Read if runs => Err("Not allowed: this thread can only read files and list folders.".into()),
        Level::Read | Level::Full => Ok(()),
        Level::Ask => {
            let app2 = app.clone();
            let message = format!("A cloud agent wants to:\n\n{what}\n\nAllow it once?");
            let ok = tauri::async_runtime::spawn_blocking(move || confirm(&app2, "A cloud agent is asking", &message, "Allow once"))
                .await
                .map_err(|e| e.to_string())?;
            if ok {
                Ok(())
            } else {
                Err("The user said no.".into())
            }
        }
    }
}

#[tauri::command]
pub async fn computer_read_file(app: tauri::AppHandle, state: tauri::State<'_, ComputerAccess>, thread_id: String, path: String) -> Result<String, String> {
    allowed(&app, &state, &thread_id, false, format!("Read the file {}", shown_exactly(&path))).await?;
    read_file_at(&path)
}

#[tauri::command]
pub async fn computer_list_dir(app: tauri::AppHandle, state: tauri::State<'_, ComputerAccess>, thread_id: String, path: String) -> Result<String, String> {
    allowed(&app, &state, &thread_id, false, format!("List the folder {}", shown_exactly(&path))).await?;
    list_dir_at(&path)
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
    allowed(&app, &state, &thread_id, true, format!("Run this command{place}:\n\n{}", shown_exactly(&command))).await?;
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
