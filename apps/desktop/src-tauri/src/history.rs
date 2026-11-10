//! Conversations the user already had with Claude Code, Codex or OpenCode on this
//! computer: the setup wizard's "Import your work" and the Scans tab. The runner does the
//! reading (`lemonlime-runner history scan|import`, which never changes the originals);
//! these commands run it and hand back its JSON, whose shape is `HistoryScan` and
//! `HistoryImportResult` in packages/protocol/src/history.ts.
//!
//! Also here: what the runner has kept of one of this app's own threads on this computer,
//! read straight from its file so a thread can be exported without starting its runner.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use serde_json::Value;

use crate::paths;
use crate::runner::{runner_command, valid_thread_id};

/// Most conversations imported in one call (the runner has the same limit).
const MAX_IDS: usize = 500;
const AGENTS: [&str; 3] = ["claude-code", "codex", "opencode"];
/// A thread's history bigger than this is not read into memory in one piece.
const MAX_THREAD_HISTORY_BYTES: u64 = 64 * 1024 * 1024;

/// Summarises the saved conversations: per agent, how many, activity per day for the last
/// year and the folders used; plus the conversations updated in the last `since_days`.
#[tauri::command]
pub async fn scan_agent_history(since_days: u32, limit: Option<u32>, runner_path: Option<String>) -> Result<Value, String> {
    if !(1..=3650).contains(&since_days) {
        return Err("Scan between 1 and 3650 days back.".into());
    }
    let mut args = vec!["history".to_string(), "scan".into(), "--since-days".into(), since_days.to_string()];
    if let Some(l) = limit {
        args.push("--limit".into());
        args.push(l.to_string());
    }
    tauri::async_runtime::spawn_blocking(move || run_history(runner_path.as_deref(), &args))
        .await
        .map_err(|e| format!("Could not scan your agents' history: {e}"))?
}

/// Makes local threads from the conversations with these ids (`<agent>:<session id>`, from
/// a scan). Importing one again returns the thread it already became.
#[tauri::command]
pub async fn import_agent_sessions(ids: Vec<String>, runner_path: Option<String>) -> Result<Value, String> {
    if ids.is_empty() {
        return Err("Pick at least one conversation to import.".into());
    }
    if ids.len() > MAX_IDS {
        return Err(format!("Import at most {MAX_IDS} conversations at once."));
    }
    if let Some(bad) = ids.iter().find(|id| !valid_history_id(id)) {
        return Err(format!("\"{bad}\" isn't a conversation id from a scan."));
    }
    let mut args = vec!["history".to_string(), "import".into()];
    args.extend(ids);
    tauri::async_runtime::spawn_blocking(move || run_history(runner_path.as_deref(), &args))
        .await
        .map_err(|e| format!("Could not import the conversations: {e}"))?
}

/// The history the runner keeps for a thread on this computer, as it is on disk: one event
/// per line. `None` when the runner has kept nothing for that thread here.
#[tauri::command]
pub async fn read_thread_history(thread_id: String) -> Result<Option<String>, String> {
    if !valid_thread_id(&thread_id) {
        return Err("That thread id is not valid.".into());
    }
    let Some(home) = runner_home() else {
        return Ok(None);
    };
    tauri::async_runtime::spawn_blocking(move || read_capped(&thread_history_file(&home, &thread_id), MAX_THREAD_HISTORY_BYTES))
        .await
        .map_err(|e| format!("Could not read the thread's history: {e}"))?
}

/// Where the runner keeps its threads: `$LEMONLIME_HOME`, or `.lemonlime` in the user's home
/// folder. The runner reads a relative `$LEMONLIME_HOME` against the folder it was started
/// in, which isn't known here, so only a full path counts.
fn runner_home() -> Option<PathBuf> {
    if let Some(home) = std::env::var_os("LEMONLIME_HOME").filter(|v| !v.is_empty()) {
        return Some(PathBuf::from(home)).filter(|p| p.is_absolute());
    }
    #[cfg(windows)]
    let home = std::env::var_os("USERPROFILE");
    #[cfg(not(windows))]
    let home = std::env::var_os("HOME");
    home.filter(|h| !h.is_empty()).map(|h| PathBuf::from(h).join(".lemonlime"))
}

fn thread_history_file(home: &Path, thread_id: &str) -> PathBuf {
    home.join("threads").join(thread_id).join("events.jsonl")
}

/// A file's text, `None` when there is no such file, and an error when it is bigger than `max`.
/// A character cut in half by a write that never finished is replaced rather than refused:
/// the reader skips that line anyway.
fn read_capped(file: &Path, max: u64) -> Result<Option<String>, String> {
    let meta = match std::fs::metadata(file) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("Could not read the thread's history: {e}")),
    };
    if !meta.is_file() {
        return Ok(None);
    }
    if meta.len() > max {
        return Err("This thread's history is too big to read in one piece.".into());
    }
    let bytes = std::fs::read(file).map_err(|e| format!("Could not read the thread's history: {e}"))?;
    Ok(Some(String::from_utf8_lossy(&bytes).into_owned()))
}

fn run_history(runner_path: Option<&str>, args: &[String]) -> Result<Value, String> {
    let program = paths::resolve_program(runner_path, "lemonlime-runner")?;
    run_program(&program, args)
}

fn run_program(program: &Path, args: &[String]) -> Result<Value, String> {
    let mut cmd = runner_command(program)?;
    cmd.args(args)
        .env("PATH", paths::search_path())
        // Node notes that its SQLite (for OpenCode's history) is new; that's not for users.
        .env("NODE_NO_WARNINGS", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let out = cmd.output().map_err(|e| format!("Could not run the runner: {e}"))?;
    if !out.status.success() {
        return Err(failure(&out.stderr));
    }
    parse_output(&out.stdout)
}

/// The runner prints one JSON object as its last line.
fn parse_output(stdout: &[u8]) -> Result<Value, String> {
    let text = String::from_utf8_lossy(stdout);
    let line = text.lines().rev().find(|l| !l.trim().is_empty()).ok_or_else(|| "The runner printed nothing.".to_string())?;
    let value: Value = serde_json::from_str(line.trim()).map_err(|e| format!("The runner's answer couldn't be read: {e}"))?;
    if value.is_object() {
        Ok(value)
    } else {
        Err("The runner's answer couldn't be read.".into())
    }
}

/// What went wrong, from the runner's last line of output, without its stack trace.
fn failure(stderr: &[u8]) -> String {
    let text = String::from_utf8_lossy(stderr);
    let line = text
        .lines()
        .map(str::trim)
        .find(|l| l.starts_with("lemonlime-runner:"))
        .or_else(|| text.lines().map(str::trim).rfind(|l| !l.is_empty()))
        .unwrap_or("it stopped without saying why");
    let line = line.strip_prefix("lemonlime-runner:").unwrap_or(line).trim();
    let line = line.strip_prefix("Error:").unwrap_or(line).trim();
    format!("Could not read your agents' history: {line}")
}

/// `<agent>:<session id>` with an agent whose history can be read and a plain id.
fn valid_history_id(id: &str) -> bool {
    let Some((agent, session)) = id.split_once(':') else {
        return false;
    };
    let bytes = session.as_bytes();
    AGENTS.contains(&agent)
        && (1..=128).contains(&bytes.len())
        && bytes[0].is_ascii_alphanumeric()
        && bytes.iter().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn history_ids() {
        assert!(valid_history_id("claude-code:5b1c2d3e-0000-4000-8000-000000000001"));
        assert!(valid_history_id("codex:0aa1b2c3-0000-7000-8000-000000000003"));
        assert!(valid_history_id("opencode:ses_e4b176e22ffeGi0SkNs0wvvfo0"));
        assert!(!valid_history_id("acp:abc"));
        assert!(!valid_history_id("codex:"));
        assert!(!valid_history_id("codex:../etc"));
        assert!(!valid_history_id("codex:-rf"));
        assert!(!valid_history_id("codex"));
        assert!(!valid_history_id(&format!("codex:{}", "a".repeat(129))));
    }

    #[test]
    fn finds_a_threads_history_under_the_runners_home() {
        let file = thread_history_file(Path::new("/home/sam/.lemonlime"), "abc123");
        assert_eq!(file, Path::new("/home/sam/.lemonlime").join("threads").join("abc123").join("events.jsonl"));
    }

    #[test]
    fn reads_a_kept_history_and_says_when_there_is_none() {
        let dir = std::env::temp_dir().join(format!("lemonlime-thread-history-test-{}", std::process::id()));
        let file = thread_history_file(&dir, "abc123");
        assert_eq!(read_capped(&file, 1024).unwrap(), None);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        // A folder where the file should be is nothing kept, not an error.
        assert_eq!(read_capped(file.parent().unwrap(), 1024).unwrap(), None);
        // The last line was cut off in the middle of a character.
        std::fs::write(&file, b"{\"seq\":1}\n{\"seq\":2,\"text\":\"caf\xc3").unwrap();
        let text = read_capped(&file, 1024).unwrap().unwrap();
        assert!(text.starts_with("{\"seq\":1}\n{\"seq\":2"));
        assert_eq!(read_capped(&file, 8).unwrap_err(), "This thread's history is too big to read in one piece.");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn reads_the_last_json_line() {
        let v = parse_output(b"noise\n{\"scannedAt\":\"x\",\"sessions\":[]}\n\n").unwrap();
        assert_eq!(v["scannedAt"], "x");
        assert!(parse_output(b"").is_err());
        assert!(parse_output(b"not json\n").is_err());
        assert!(parse_output(b"[1,2]\n").is_err());
    }

    #[test]
    fn explains_failures_without_stack_traces() {
        let msg = failure(b"lemonlime-runner: Error: --since-days must be a whole number\n    at historyCommand (cli.ts:1:1)\n");
        assert_eq!(msg, "Could not read your agents' history: --since-days must be a whole number");
        assert_eq!(failure(b""), "Could not read your agents' history: it stopped without saying why");
    }

    #[cfg(unix)]
    #[test]
    fn runs_the_runner_and_returns_its_answer() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("lemonlime-history-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let fake = dir.join("fake-runner");
        std::fs::write(&fake, "#!/bin/sh\nif [ \"$2\" = scan ]; then echo '{\"ok\":true,\"args\":\"'\"$*\"'\"}'; else echo 'lemonlime-runner: Error: nope' >&2; exit 1; fi\n").unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        let v = run_program(&fake, &["history".into(), "scan".into(), "--since-days".into(), "30".into()]).unwrap();
        assert_eq!(v["args"], "history scan --since-days 30");
        let err = run_program(&fake, &["history".into(), "import".into(), "codex:x1".into()]).unwrap_err();
        assert_eq!(err, "Could not read your agents' history: nope");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
