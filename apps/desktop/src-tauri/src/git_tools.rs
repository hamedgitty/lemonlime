//! Git help for threads that aren't running: the new-thread screen's branch picker and pull
//! request lookup, and removing a finished thread's worktree. The runner does the work
//! (`lemonlime-runner git branches|pull-request|remove-worktree`) and prints one JSON line,
//! shaped like `BranchList` and `PullRequestLookup` in packages/protocol/src/git-review.ts.

use std::process::Stdio;

use serde_json::Value;

use crate::paths;
use crate::runner::{runner_command, valid_thread_id};

/// The repository's local and origin branches, newest first, and the one checked out.
#[tauri::command]
pub async fn list_branches(repo_path: String, runner_path: Option<String>) -> Result<Value, String> {
    let args = vec!["git".to_string(), "branches".into(), "--repo".into(), repo_path];
    tauri::async_runtime::spawn_blocking(move || run_git_tool(runner_path.as_deref(), &args))
        .await
        .map_err(|e| format!("Could not list the branches: {e}"))?
}

/// A pull request of the repository, from a link or `#123`, found with the GitHub CLI.
#[tauri::command]
pub async fn lookup_pull_request(repo_path: String, reference: String, runner_path: Option<String>) -> Result<Value, String> {
    let reference = reference.trim().to_string();
    if reference.is_empty() || reference.len() > 500 || reference.starts_with('-') {
        return Err("Paste a pull request link, or type # and its number.".into());
    }
    let args = vec!["git".to_string(), "pull-request".into(), "--repo".into(), repo_path, "--ref".into(), reference];
    tauri::async_runtime::spawn_blocking(move || run_git_tool(runner_path.as_deref(), &args))
        .await
        .map_err(|e| format!("Could not look the pull request up: {e}"))?
}

/// Removes a stopped thread's worktree, keeping its history and branch. Refused when the
/// worktree has changes that aren't committed.
#[tauri::command]
pub async fn remove_thread_worktree(thread_id: String, repo_path: String, runner_path: Option<String>) -> Result<Value, String> {
    if !valid_thread_id(&thread_id) {
        return Err("That thread id is not valid.".into());
    }
    let args = vec!["git".to_string(), "remove-worktree".into(), "--thread".into(), thread_id, "--source-repo".into(), repo_path];
    tauri::async_runtime::spawn_blocking(move || run_git_tool(runner_path.as_deref(), &args))
        .await
        .map_err(|e| format!("Could not remove the thread's folder: {e}"))?
}

fn run_git_tool(runner_path: Option<&str>, args: &[String]) -> Result<Value, String> {
    let program = paths::resolve_program(runner_path, "lemonlime-runner")?;
    let mut cmd = runner_command(&program)?;
    cmd.args(args)
        .env("PATH", paths::search_path())
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
    let text = String::from_utf8_lossy(&out.stdout);
    let line = text.lines().rev().find(|l| !l.trim().is_empty()).ok_or_else(|| "The runner printed nothing.".to_string())?;
    serde_json::from_str::<Value>(line.trim())
        .ok()
        .filter(Value::is_object)
        .ok_or_else(|| "The runner's answer couldn't be read.".to_string())
}

/// The runner's own words for what went wrong, without its stack trace.
fn failure(stderr: &[u8]) -> String {
    let text = String::from_utf8_lossy(stderr);
    let line = text
        .lines()
        .map(str::trim)
        .find(|l| l.starts_with("lemonlime-runner:"))
        .or_else(|| text.lines().map(str::trim).rfind(|l| !l.is_empty()))
        .unwrap_or("it stopped without saying why");
    let line = line.strip_prefix("lemonlime-runner:").unwrap_or(line).trim();
    line.strip_prefix("Error:").unwrap_or(line).trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::failure;

    #[test]
    fn failure_keeps_the_runners_message() {
        let err = b"lemonlime-runner: Error: There's no pull request #4 in this repository.\n    at x (y.js:1:1)\n";
        assert_eq!(failure(err), "There's no pull request #4 in this repository.");
    }
}
