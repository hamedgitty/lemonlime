//! The user's agent accounts on this computer: several Claude Code or Codex sign-ins,
//! each in a config folder of its own. The runner does the work
//! (`lemonlime-runner accounts …`, see packages/runner/src/accounts-cli.ts); these commands
//! run it and hand back its JSON. A sign-in streams its progress to the window as
//! `account-login` events. No token ever passes through here.

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Stdio};
use std::sync::Mutex;
use std::thread;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, State};

use crate::paths;
use crate::runner::runner_command;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const AGENTS: [&str; 2] = ["claude-code", "codex"];
const ON_LIMIT: [&str; 3] = ["wait", "switch", "ask"];

/// The sign-in running now, if any (one at a time).
#[derive(Default)]
pub struct AccountLogin(Mutex<Option<(Child, Option<ChildStdin>)>>);

impl AccountLogin {
    fn lock(&self) -> std::sync::MutexGuard<'_, Option<(Child, Option<ChildStdin>)>> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Ends a sign-in still running. Called when the app exits.
    pub fn stop(&self) {
        if let Some((mut child, stdin)) = self.lock().take() {
            drop(stdin);
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[derive(Serialize, Clone)]
struct LoginEvent {
    /// One line the runner printed: `{"login": …}` or `{"done": true, "ok": …}`.
    line: Value,
}

fn valid_id(id: &str) -> bool {
    let b = id.as_bytes();
    (1..=40).contains(&b.len()) && b[0].is_ascii_alphanumeric() && b.iter().all(|c| c.is_ascii_digit() || c.is_ascii_lowercase() || *c == b'-')
}

/// Checks a request from the window before it reaches the runner's command line.
fn checked_args(command: &str, agent: Option<&str>, id: Option<&str>, label: Option<&str>, on_limit: Option<&str>) -> Result<Vec<String>, String> {
    let mut args = vec!["accounts".to_string(), command.to_string()];
    let agent_arg = |args: &mut Vec<String>| -> Result<(), String> {
        let a = agent.filter(|a| AGENTS.contains(a)).ok_or("Pick Claude Code or Codex.")?;
        args.extend(["--agent".into(), a.into()]);
        Ok(())
    };
    let id_arg = |args: &mut Vec<String>| -> Result<(), String> {
        let i = id.filter(|i| valid_id(i)).ok_or("That account id is not valid.")?;
        args.extend(["--id".into(), i.into()]);
        Ok(())
    };
    let label_arg = |args: &mut Vec<String>| -> Result<(), String> {
        let l = label.map(str::trim).filter(|l| !l.is_empty() && l.chars().count() <= 80).ok_or("Give the account a name (up to 80 characters).")?;
        args.extend(["--label".into(), l.into()]);
        Ok(())
    };
    match command {
        "list" => {}
        "add" => {
            agent_arg(&mut args)?;
            label_arg(&mut args)?;
        }
        "remove" | "default" | "login" => {
            agent_arg(&mut args)?;
            id_arg(&mut args)?;
        }
        "rename" => {
            agent_arg(&mut args)?;
            id_arg(&mut args)?;
            label_arg(&mut args)?;
        }
        "on-limit" => {
            let v = on_limit.filter(|v| ON_LIMIT.contains(v)).ok_or("Pick wait, switch or ask.")?;
            args.push(v.into());
        }
        _ => return Err(format!("Unknown accounts command \"{command}\".")),
    }
    Ok(args)
}

fn configure(cmd: &mut std::process::Command) {
    cmd.env("PATH", paths::search_path()).env("NODE_NO_WARNINGS", "1");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
}

/// What went wrong, from the runner's own line, without a stack trace.
fn failure(stderr: &[u8]) -> String {
    let text = String::from_utf8_lossy(stderr);
    let line = text
        .lines()
        .map(str::trim)
        .find(|l| l.starts_with("lemonlime-runner:"))
        .or_else(|| text.lines().map(str::trim).rfind(|l| !l.is_empty()))
        .unwrap_or("it stopped without saying why");
    line.strip_prefix("lemonlime-runner:").unwrap_or(line).trim().to_string()
}

/// Lists, adds, removes, renames accounts, sets the default, or sets what happens at a
/// usage limit. Returns the runner's JSON answer.
#[tauri::command]
pub async fn agent_accounts(
    command: String,
    agent: Option<String>,
    id: Option<String>,
    label: Option<String>,
    on_limit: Option<String>,
    runner_path: Option<String>,
) -> Result<Value, String> {
    if command == "login" {
        return Err("Use account_login_start to sign in.".into());
    }
    let args = checked_args(&command, agent.as_deref(), id.as_deref(), label.as_deref(), on_limit.as_deref())?;
    tauri::async_runtime::spawn_blocking(move || {
        let program = paths::resolve_program(runner_path.as_deref(), "lemonlime-runner")?;
        let mut cmd = runner_command(&program)?;
        cmd.args(&args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        configure(&mut cmd);
        let out = cmd.output().map_err(|e| format!("Could not run the runner: {e}"))?;
        if !out.status.success() {
            return Err(failure(&out.stderr));
        }
        let text = String::from_utf8_lossy(&out.stdout);
        let line = text.lines().rev().find(|l| !l.trim().is_empty()).ok_or("The runner printed nothing.")?;
        serde_json::from_str::<Value>(line.trim()).map_err(|e| format!("The runner's answer couldn't be read: {e}"))
    })
    .await
    .map_err(|e| format!("Could not run the runner: {e}"))?
}

/// Signs an account in (its agent's own sign-in, in the account's folder). Progress
/// arrives as `account-login` events; a new sign-in replaces one still running.
#[tauri::command]
pub fn account_login_start(app: AppHandle, state: State<'_, AccountLogin>, agent: String, id: String, runner_path: Option<String>) -> Result<(), String> {
    let args = checked_args("login", Some(&agent), Some(&id), None, None)?;
    state.stop();
    let program = paths::resolve_program(runner_path.as_deref(), "lemonlime-runner")?;
    let mut cmd = runner_command(&program)?;
    cmd.args(&args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    configure(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| format!("Could not run the runner: {e}"))?;
    let stdout = child.stdout.take().ok_or("The runner's output couldn't be read.")?;
    let stderr = child.stderr.take();
    let stdin = child.stdin.take();
    *state.lock() = Some((child, stdin));
    thread::spawn(move || {
        let mut finished = false;
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Ok(value) = serde_json::from_str::<Value>(line.trim()) {
                finished |= value.get("done").is_some();
                let _ = app.emit("account-login", LoginEvent { line: value });
            }
        }
        if !finished {
            let mut err = Vec::new();
            if let Some(mut s) = stderr {
                let _ = std::io::Read::read_to_end(&mut s, &mut err);
            }
            let message = failure(&err);
            let _ = app.emit("account-login", LoginEvent { line: serde_json::json!({ "login": { "state": "failed", "message": message } }) });
            let _ = app.emit("account-login", LoginEvent { line: serde_json::json!({ "done": true, "ok": false }) });
        }
    });
    Ok(())
}

/// Text the sign-in asked for, e.g. the code the page showed.
#[tauri::command]
pub fn account_login_input(state: State<'_, AccountLogin>, text: String) -> Result<(), String> {
    let mut guard = state.lock();
    let stdin = guard.as_mut().and_then(|(_, s)| s.as_mut()).ok_or("No sign-in is running.")?;
    let clean: String = text.chars().filter(|c| !c.is_control()).take(10_000).collect();
    writeln!(stdin, "{clean}").and_then(|_| stdin.flush()).map_err(|e| e.to_string())
}

/// Cancels the sign-in: closing its input tells the runner to stop it.
#[tauri::command]
pub fn account_login_cancel(state: State<'_, AccountLogin>) {
    let taken = state.lock().take();
    // Reap it once the runner has stopped it, without holding the window up.
    if let Some((mut child, stdin)) = taken {
        drop(stdin);
        thread::spawn(move || {
            for _ in 0..50 {
                if matches!(child.try_wait(), Ok(Some(_))) {
                    return;
                }
                thread::sleep(std::time::Duration::from_millis(100));
            }
            let _ = child.kill();
            let _ = child.wait();
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checks_what_reaches_the_runner() {
        assert_eq!(checked_args("list", None, None, None, None).unwrap(), vec!["accounts", "list"]);
        assert_eq!(
            checked_args("add", Some("codex"), None, Some(" Work "), None).unwrap(),
            vec!["accounts", "add", "--agent", "codex", "--label", "Work"]
        );
        assert_eq!(
            checked_args("default", Some("claude-code"), Some("work-2"), None, None).unwrap(),
            vec!["accounts", "default", "--agent", "claude-code", "--id", "work-2"]
        );
        assert_eq!(checked_args("on-limit", None, None, None, Some("ask")).unwrap(), vec!["accounts", "on-limit", "ask"]);
        assert!(checked_args("add", Some("opencode"), None, Some("x"), None).is_err());
        assert!(checked_args("remove", Some("codex"), Some("../x"), None, None).is_err());
        assert!(checked_args("remove", Some("codex"), Some("-rf"), None, None).is_err());
        assert!(checked_args("add", Some("codex"), None, Some("  "), None).is_err());
        assert!(checked_args("on-limit", None, None, None, Some("never")).is_err());
        assert!(checked_args("format", None, None, None, None).is_err());
    }

    #[test]
    fn explains_failures_without_stack_traces() {
        assert_eq!(failure(b"lemonlime-runner: There's no such account.\n    at x (y:1:1)\n"), "There's no such account.");
        assert_eq!(failure(b""), "it stopped without saying why");
    }
}
