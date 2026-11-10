//! Previews of cloud dev servers. For each one the user opens, the bundled runner runs
//! in `tunnel` mode: it listens on 127.0.0.1 only and carries each connection to the
//! sandbox's port over the runner's WebSocket. Client tokens expire, so the window keeps
//! sending fresh ones on the tunnel's stdin.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, Stdio};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::Duration;

use tauri::State;

use crate::paths;
use crate::runner::{runner_command, terminate};

/// How much of what a tunnel printed before it gave up is kept, to say why.
const SAID_MAX: usize = 2000;

struct Tunnel {
    child: Child,
    stdin: ChildStdin,
    port: u16,
}

#[derive(Default)]
struct Inner {
    open: HashMap<String, Tunnel>,
    /// Counts every start and every close, so a start can tell whether its preview was
    /// closed after it was asked for.
    clock: u64,
    /// When each preview was last closed, on that clock.
    closed: HashMap<String, u64>,
}

impl Inner {
    fn tick(&mut self) -> u64 {
        self.clock += 1;
        self.clock
    }

    fn closed_since(&self, key: &str, asked: u64) -> bool {
        self.closed.get(key).is_some_and(|at| *at > asked)
    }
}

#[derive(Default)]
pub struct Tunnels {
    inner: Mutex<Inner>,
    /// Held while a preview starts. One start at a time: two for the same preview would
    /// each start a tunnel and one of them would never be stopped.
    turn: tauri::async_runtime::Mutex<()>,
}

impl Tunnels {
    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn stop_all(&self) {
        let tunnels: Vec<Tunnel> = self.lock().open.drain().map(|(_, t)| t).collect();
        let stopping: Vec<_> = tunnels.into_iter().map(|t| thread::spawn(move || terminate(t.child))).collect();
        for s in stopping {
            let _ = s.join();
        }
    }
}

fn key(runner_url: &str, port: u16) -> String {
    format!("{runner_url}#{port}")
}

fn token_line(token: &str) -> String {
    format!("{}\n", serde_json::json!({ "token": token }))
}

fn check(runner_url: &str, port: u16) -> Result<(), String> {
    if !(runner_url.starts_with("ws://") || runner_url.starts_with("wss://")) || runner_url.chars().any(char::is_whitespace) {
        return Err("That isn't a runner address.".into());
    }
    if port == 0 {
        return Err("That isn't a port.".into());
    }
    Ok(())
}

const CLOSED_FIRST: &str = "The preview was closed before it had started.";

/// The last part of `text`, cut at a character.
fn tail(text: &str, max: usize) -> &str {
    let mut from = text.len().saturating_sub(max);
    while !text.is_char_boundary(from) {
        from += 1;
    }
    &text[from..]
}

/// Starts the tunnel and waits until it listens. Returns the process, its stdin and the local port.
fn start_tunnel(runner_url: &str, port: u16, token: &str, runner_path: Option<&str>) -> Result<(Child, ChildStdin, u16), String> {
    let program = paths::resolve_program(runner_path, "lemonlime-runner")?;
    let mut cmd = runner_command(&program)?;
    cmd.arg("tunnel")
        .arg("--url")
        .arg(runner_url)
        .arg("--port")
        .arg(port.to_string())
        .env("PATH", paths::search_path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let mut child = cmd.spawn().map_err(|e| format!("Could not start the preview: {e}"))?;
    let (Some(mut stdin), Some(stdout), Some(stderr)) = (child.stdin.take(), child.stdout.take(), child.stderr.take()) else {
        terminate(child);
        return Err("Could not talk to the preview tunnel.".into());
    };
    if let Err(e) = stdin.write_all(token_line(token).as_bytes()) {
        terminate(child);
        return Err(format!("Could not start the preview: {e}"));
    }

    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let parsed: Option<u16> = serde_json::from_str::<serde_json::Value>(&line)
                .ok()
                .filter(|v| v["event"] == "listening")
                .and_then(|v| v["port"].as_u64())
                .and_then(|p| u16::try_from(p).ok());
            if let Some(p) = parsed {
                let _ = tx.send(p);
            }
        }
    });
    // What the tunnel says when something goes wrong. Read for as long as it runs, so it
    // never stalls on a full pipe; only the last part is kept.
    let said = Arc::new(Mutex::new(String::new()));
    let saying = Arc::clone(&said);
    thread::spawn(move || {
        let mut stderr = stderr;
        let mut buf = [0u8; 2048];
        while let Ok(n) = stderr.read(&mut buf) {
            if n == 0 {
                break;
            }
            let mut kept = saying.lock().unwrap_or_else(|e| e.into_inner());
            kept.push_str(&String::from_utf8_lossy(&buf[..n]));
            if kept.len() > SAID_MAX * 2 {
                *kept = tail(&kept, SAID_MAX).to_string();
            }
        }
    });

    match rx.recv_timeout(Duration::from_secs(15)) {
        Ok(local) => Ok((child, stdin, local)),
        Err(RecvTimeoutError::Timeout) => {
            terminate(child);
            Err("The preview didn't start in time.".into())
        }
        // The tunnel stopped before it was listening.
        Err(RecvTimeoutError::Disconnected) => {
            terminate(child);
            thread::sleep(Duration::from_millis(50));
            let kept = said.lock().unwrap_or_else(|e| e.into_inner());
            let why = tail(kept.trim(), SAID_MAX);
            Err(if why.is_empty() { "The preview couldn't start.".to_string() } else { format!("The preview couldn't start:\n{why}") })
        }
    }
}

/// Starts (or reuses) the tunnel for a preview and returns the local port to open.
#[tauri::command]
pub async fn start_preview_tunnel(
    state: State<'_, Tunnels>,
    runner_url: String,
    port: u16,
    token: String,
    runner_path: Option<String>,
) -> Result<u16, String> {
    check(&runner_url, port)?;
    let k = key(&runner_url, port);
    let asked = state.lock().tick();
    let _turn = state.turn.lock().await;

    let dead = {
        let mut inner = state.lock();
        if inner.closed_since(&k, asked) {
            return Err(CLOSED_FIRST.into());
        }
        if let Some(t) = inner.open.get_mut(&k) {
            if matches!(t.child.try_wait(), Ok(None)) && t.stdin.write_all(token_line(&token).as_bytes()).is_ok() {
                return Ok(t.port);
            }
        }
        inner.open.remove(&k)
    };

    let started = tauri::async_runtime::spawn_blocking(move || {
        if let Some(dead) = dead {
            terminate(dead.child);
        }
        start_tunnel(&runner_url, port, &token, runner_path.as_deref())
    })
    .await
    .map_err(|e| format!("Could not start the preview: {e}"))?;
    let (child, stdin, local) = started?;

    let mut inner = state.lock();
    if inner.closed_since(&k, asked) {
        drop(inner);
        // Closed while it was starting: nothing would ever stop this tunnel, so it ends here.
        thread::spawn(move || terminate(child));
        return Err(CLOSED_FIRST.into());
    }
    inner.closed.remove(&k);
    inner.open.insert(k, Tunnel { child, stdin, port: local });
    Ok(local)
}

/// A fresh client token for an open tunnel (they last 15 minutes).
#[tauri::command]
pub fn preview_tunnel_token(state: State<'_, Tunnels>, runner_url: String, port: u16, token: String) -> bool {
    state.lock().open.get_mut(&key(&runner_url, port)).is_some_and(|t| t.stdin.write_all(token_line(&token).as_bytes()).is_ok())
}

#[tauri::command]
pub fn stop_preview_tunnel(state: State<'_, Tunnels>, runner_url: String, port: u16) {
    let k = key(&runner_url, port);
    let closed = {
        let mut inner = state.lock();
        // A start still under way for this preview sees this and stops its own tunnel.
        let at = inner.tick();
        let stopped = inner.open.remove(&k);
        inner.closed.insert(k, at);
        stopped
    };
    if let Some(t) = closed {
        // Stopping waits for the tunnel to go; the window doesn't.
        thread::spawn(move || terminate(t.child));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_runner_addresses() {
        assert!(check("wss://host.example/sandbox/lemonlime-abc123/ws", 5173).is_ok());
        assert!(check("ws://127.0.0.1:7420/ws", 3000).is_ok());
        assert!(check("https://example.com", 3000).is_err());
        assert!(check("ws://x --evil", 3000).is_err());
        assert!(check("ws://127.0.0.1:7420/ws", 0).is_err());
        assert_eq!(token_line("abc"), "{\"token\":\"abc\"}\n");
    }

    #[test]
    fn a_start_knows_when_its_preview_was_closed_meanwhile() {
        let mut inner = Inner::default();
        let asked = inner.tick();
        assert!(!inner.closed_since("a", asked));
        let at = inner.tick();
        inner.closed.insert("a".into(), at);
        assert!(inner.closed_since("a", asked), "closed after it was asked for");
        assert!(!inner.closed_since("b", asked), "another preview is not affected");
        let later = inner.tick();
        assert!(!inner.closed_since("a", later), "opened again after the close");
    }

    #[test]
    fn keeps_the_end_of_what_a_tunnel_said() {
        assert_eq!(tail("hello", 10), "hello");
        assert_eq!(tail("hello", 3), "llo");
        assert_eq!(tail("héllo", 4), "llo", "never cuts a character in half");
    }
}
