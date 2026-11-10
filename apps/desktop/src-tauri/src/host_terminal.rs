//! Terminals on this computer that don't belong to a thread: the side panel's "+ New tab →
//! Terminal". Each is a real shell in a pseudo-terminal; its output reaches the window as
//! `host-terminal` events.

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{sync_channel, SyncSender, TrySendError};
use std::sync::Mutex;
use std::thread;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::paths;

/// How many pieces of typed text may wait for a shell that has stopped reading.
const TYPED_AHEAD: usize = 1024;

struct Term {
    master: Box<dyn MasterPty + Send>,
    /// What the user types, on its way to the shell. A thread of its own does the writing,
    /// so a shell that has stopped reading can't hold up the window or the other terminals.
    typed: SyncSender<Vec<u8>>,
    child: Box<dyn Child + Send + Sync>,
}

/// Ends a shell and collects it, so nothing of it is left behind.
fn end(mut t: Term) {
    let _ = t.child.kill();
    let _ = t.child.wait();
}

#[derive(Default)]
pub struct HostTerminals(Mutex<HashMap<u32, Term>>);

impl HostTerminals {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<u32, Term>> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Ends every shell. Called when the app exits.
    pub fn close_all(&self) {
        let terms: Vec<Term> = self.lock().drain().map(|(_, t)| t).collect();
        let ending: Vec<_> = terms.into_iter().map(|t| thread::spawn(move || end(t))).collect();
        for e in ending {
            let _ = e.join();
        }
    }
}

static NEXT_ID: AtomicU32 = AtomicU32::new(1);

#[derive(Serialize, Clone)]
struct Output {
    id: u32,
    /// Text the shell printed (absent once it has exited).
    data: Option<String>,
    exited: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Opened {
    id: u32,
    /// The shell's name, for the tab ("zsh", "bash", "powershell").
    shell: String,
}

fn default_shell() -> String {
    #[cfg(windows)]
    {
        if paths::find_program("pwsh").is_some() {
            return "pwsh.exe".into();
        }
        "powershell.exe".into()
    }
    #[cfg(not(windows))]
    {
        std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/bin/zsh".into())
    }
}

fn home() -> Option<PathBuf> {
    #[cfg(windows)]
    let h = std::env::var_os("USERPROFILE");
    #[cfg(not(windows))]
    let h = std::env::var_os("HOME");
    h.filter(|v| !v.is_empty()).map(PathBuf::from)
}

/// Splits off a trailing, incomplete UTF-8 sequence so characters never break across reads.
fn split_utf8(buf: &[u8]) -> (String, Vec<u8>) {
    match std::str::from_utf8(buf) {
        Ok(s) => (s.to_string(), Vec::new()),
        Err(e) if e.error_len().is_none() => {
            let cut = e.valid_up_to();
            (String::from_utf8_lossy(&buf[..cut]).into_owned(), buf[cut..].to_vec())
        }
        Err(_) => (String::from_utf8_lossy(buf).into_owned(), Vec::new()),
    }
}

/// Starts a shell in `cwd` (or the home folder) and streams what it prints.
#[tauri::command(async)]
pub fn host_terminal_open(app: AppHandle, state: State<'_, HostTerminals>, cols: u16, rows: u16, cwd: Option<String>) -> Result<Opened, String> {
    let pty = native_pty_system()
        .openpty(PtySize { rows: rows.max(2), cols: cols.max(10), pixel_width: 0, pixel_height: 0 })
        .map_err(|e| format!("Couldn't open a terminal: {e}"))?;
    let shell = default_shell();
    let mut cmd = CommandBuilder::new(&shell);
    #[cfg(not(windows))]
    cmd.arg("-l");
    let dir = cwd.map(PathBuf::from).filter(|p| p.is_absolute() && p.is_dir()).or_else(home);
    if let Some(d) = dir {
        cmd.cwd(d);
    }
    cmd.env("PATH", paths::search_path());
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    let child = pty.slave.spawn_command(cmd).map_err(|e| format!("Couldn't start {shell}: {e}"))?;
    drop(pty.slave);
    let mut reader = pty.master.try_clone_reader().map_err(|e| e.to_string())?;
    let mut writer = pty.master.take_writer().map_err(|e| e.to_string())?;
    let (typed, typing) = sync_channel::<Vec<u8>>(TYPED_AHEAD);
    let id = NEXT_ID.fetch_add(1, Ordering::SeqCst);
    state.lock().insert(id, Term { master: pty.master, typed, child });

    // Ends when the terminal is closed (nothing can be typed any more) or the shell is gone.
    thread::spawn(move || {
        for bytes in typing {
            if writer.write_all(&bytes).and_then(|()| writer.flush()).is_err() {
                break;
            }
        }
    });

    thread::spawn(move || {
        let mut buf = [0u8; 16 * 1024];
        let mut carry: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    carry.extend_from_slice(&buf[..n]);
                    let (text, rest) = split_utf8(&carry);
                    carry = rest;
                    if !text.is_empty() {
                        let _ = app.emit("host-terminal", Output { id, data: Some(text), exited: false });
                    }
                }
            }
        }
        // The shell is gone: forget it here too, so its process is collected and typing
        // into it says so.
        let gone = app.state::<HostTerminals>().lock().remove(&id);
        if let Some(t) = gone {
            end(t);
        }
        let _ = app.emit("host-terminal", Output { id, data: None, exited: true });
    });

    let name = PathBuf::from(&shell).file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or(shell);
    Ok(Opened { id, shell: name })
}

#[tauri::command]
pub fn host_terminal_write(state: State<'_, HostTerminals>, id: u32, data: String) -> Result<(), String> {
    let terms = state.lock();
    let t = terms.get(&id).ok_or("That terminal has closed.")?;
    t.typed.try_send(data.into_bytes()).map_err(|e| match e {
        TrySendError::Full(_) => "The terminal isn't reading what you type right now.".to_string(),
        TrySendError::Disconnected(_) => "That terminal has closed.".to_string(),
    })
}

#[tauri::command]
pub fn host_terminal_resize(state: State<'_, HostTerminals>, id: u32, cols: u16, rows: u16) -> Result<(), String> {
    let terms = state.lock();
    let t = terms.get(&id).ok_or("That terminal has closed.")?;
    t.master.resize(PtySize { rows: rows.max(2), cols: cols.max(10), pixel_width: 0, pixel_height: 0 }).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn host_terminal_close(state: State<'_, HostTerminals>, id: u32) {
    let closed = state.lock().remove(&id);
    if let Some(t) = closed {
        // Ending a shell can take a moment; the window doesn't wait for it.
        thread::spawn(move || end(t));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_split_characters_for_the_next_read() {
        let bytes = "héllo".as_bytes();
        let (text, rest) = split_utf8(&bytes[..2]);
        assert_eq!(text, "h");
        assert_eq!(rest, vec![0xc3]);
        let mut joined = rest;
        joined.extend_from_slice(&bytes[2..]);
        assert_eq!(split_utf8(&joined).0, "éllo");
    }
}

#[cfg(test)]
mod live_checks {
    use super::*;

    /// A real shell in a real pseudo-terminal: type a command, read its answer.
    #[test]
    #[ignore]
    fn live_runs_a_shell() {
        let pty = native_pty_system().openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 }).unwrap();
        let mut cmd = CommandBuilder::new(default_shell());
        cmd.env("PATH", paths::search_path());
        let mut child = pty.slave.spawn_command(cmd).unwrap();
        drop(pty.slave);
        let mut reader = pty.master.try_clone_reader().unwrap();
        let mut writer = pty.master.take_writer().unwrap();
        writer.write_all(b"echo lemon$((1+1))lime; exit\r").unwrap();
        let mut all = Vec::new();
        let mut buf = [0u8; 4096];
        while let Ok(n) = reader.read(&mut buf) {
            if n == 0 {
                break;
            }
            all.extend_from_slice(&buf[..n]);
            if String::from_utf8_lossy(&all).contains("lemon2lime") {
                break;
            }
        }
        let _ = child.kill();
        let text = String::from_utf8_lossy(&all);
        assert!(text.contains("lemon2lime"), "shell said: {text}");
        println!("shell answered");
    }
}
