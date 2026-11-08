//! Terminals on this computer that don't belong to a thread: the side panel's "+ New tab →
//! Terminal". Each is a real shell in a pseudo-terminal; its output reaches the window as
//! `host-terminal` events.

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use std::thread;
use tauri::{AppHandle, Emitter, State};

use crate::paths;

struct Term {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Default)]
pub struct HostTerminals(Mutex<HashMap<u32, Term>>);

impl HostTerminals {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<u32, Term>> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Ends every shell. Called when the app exits.
    pub fn close_all(&self) {
        for (_, mut t) in self.lock().drain() {
            let _ = t.child.kill();
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
#[tauri::command]
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
    let writer = pty.master.take_writer().map_err(|e| e.to_string())?;
    let id = NEXT_ID.fetch_add(1, Ordering::SeqCst);
    state.lock().insert(id, Term { master: pty.master, writer, child });

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
        let _ = app.emit("host-terminal", Output { id, data: None, exited: true });
    });

    let name = PathBuf::from(&shell).file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or(shell);
    Ok(Opened { id, shell: name })
}

#[tauri::command]
pub fn host_terminal_write(state: State<'_, HostTerminals>, id: u32, data: String) -> Result<(), String> {
    let mut terms = state.lock();
    let t = terms.get_mut(&id).ok_or("That terminal has closed.")?;
    t.writer.write_all(data.as_bytes()).and_then(|_| t.writer.flush()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn host_terminal_resize(state: State<'_, HostTerminals>, id: u32, cols: u16, rows: u16) -> Result<(), String> {
    let terms = state.lock();
    let t = terms.get(&id).ok_or("That terminal has closed.")?;
    t.master.resize(PtySize { rows: rows.max(2), cols: cols.max(10), pixel_width: 0, pixel_height: 0 }).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn host_terminal_close(state: State<'_, HostTerminals>, id: u32) {
    if let Some(mut t) = state.lock().remove(&id) {
        let _ = t.child.kill();
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
