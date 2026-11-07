//! Previews of cloud dev servers. For each one the user opens, the bundled runner runs
//! in `tunnel` mode: it listens on 127.0.0.1 only and carries each connection to the
//! sandbox's port over the runner's WebSocket. Client tokens expire, so the window keeps
//! sending fresh ones on the tunnel's stdin.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Stdio};
use std::sync::mpsc;
use std::sync::{Mutex, MutexGuard};
use std::thread;
use std::time::Duration;

use tauri::State;

use crate::paths;
use crate::runner::{runner_command, terminate};

struct Tunnel {
    child: Child,
    stdin: ChildStdin,
    port: u16,
}

#[derive(Default)]
pub struct Tunnels(Mutex<HashMap<String, Tunnel>>);

impl Tunnels {
    fn lock(&self) -> MutexGuard<'_, HashMap<String, Tunnel>> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn stop_all(&self) {
        for (_, t) in self.lock().drain() {
            terminate(t.child);
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
    {
        let mut tunnels = state.lock();
        if let Some(t) = tunnels.get_mut(&k) {
            if matches!(t.child.try_wait(), Ok(None)) && t.stdin.write_all(token_line(&token).as_bytes()).is_ok() {
                return Ok(t.port);
            }
            if let Some(dead) = tunnels.remove(&k) {
                terminate(dead.child);
            }
        }
    }

    let program = paths::resolve_program(runner_path.as_deref(), "lemonlime-runner")?;
    let (child, stdin, local) = tauri::async_runtime::spawn_blocking(move || -> Result<(Child, ChildStdin, u16), String> {
        let mut cmd = runner_command(&program)?;
        cmd.arg("tunnel")
            .arg("--url")
            .arg(&runner_url)
            .arg("--port")
            .arg(port.to_string())
            .env("PATH", paths::search_path())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000);
        }
        let mut child = cmd.spawn().map_err(|e| format!("Could not start the preview: {e}"))?;
        let mut stdin = child.stdin.take().ok_or("Could not talk to the preview tunnel.")?;
        stdin.write_all(token_line(&token).as_bytes()).map_err(|e| format!("Could not start the preview: {e}"))?;
        let stdout = child.stdout.take().ok_or("Could not talk to the preview tunnel.")?;
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
        match rx.recv_timeout(Duration::from_secs(15)) {
            Ok(local) => Ok((child, stdin, local)),
            Err(_) => {
                terminate(child);
                Err("The preview didn't start in time.".into())
            }
        }
    })
    .await
    .map_err(|e| format!("Could not start the preview: {e}"))??;

    state.lock().insert(k, Tunnel { child, stdin, port: local });
    Ok(local)
}

/// A fresh client token for an open tunnel (they last 15 minutes).
#[tauri::command]
pub fn preview_tunnel_token(state: State<'_, Tunnels>, runner_url: String, port: u16, token: String) -> bool {
    state.lock().get_mut(&key(&runner_url, port)).is_some_and(|t| t.stdin.write_all(token_line(&token).as_bytes()).is_ok())
}

#[tauri::command]
pub fn stop_preview_tunnel(state: State<'_, Tunnels>, runner_url: String, port: u16) {
    if let Some(t) = state.lock().remove(&key(&runner_url, port)) {
        terminate(t.child);
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
}
