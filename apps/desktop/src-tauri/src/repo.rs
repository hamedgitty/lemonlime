//! Small git checks for the "new local thread" form.

use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

use serde::Serialize;

use crate::paths;

#[derive(Serialize)]
pub struct RepoInfo {
    /// Current branch, or None for a detached HEAD.
    branch: Option<String>,
}

/// Checks that `path` is inside a git work tree and returns its current branch.
#[tauri::command]
pub async fn inspect_repo(path: String) -> Result<RepoInfo, String> {
    tauri::async_runtime::spawn_blocking(move || inspect_blocking(PathBuf::from(path)))
        .await
        .map_err(|e| format!("Could not inspect the folder: {e}"))?
}

fn inspect_blocking(dir: PathBuf) -> Result<RepoInfo, String> {
    if !dir.is_dir() {
        return Err(format!("{} is not a folder.", dir.display()));
    }
    let inside = git(&dir, &["rev-parse", "--is-inside-work-tree"])?;
    if !inside.status.success() || String::from_utf8_lossy(&inside.stdout).trim() != "true" {
        return Err("This folder is not a git repository. Run `git init` in it first, or pick another folder.".into());
    }
    // Works on a fresh repository with no commits too.
    let head = git(&dir, &["symbolic-ref", "--short", "-q", "HEAD"])?;
    let branch = if head.status.success() {
        Some(String::from_utf8_lossy(&head.stdout).trim().to_string()).filter(|b| !b.is_empty())
    } else {
        None
    };
    Ok(RepoInfo { branch })
}

fn git(dir: &Path, args: &[&str]) -> Result<Output, String> {
    let program = paths::find_program("git").ok_or_else(|| "Git is not installed, or not on your PATH.".to_string())?;
    let mut cmd = Command::new(program);
    cmd.args(args)
        .current_dir(dir)
        .env("PATH", paths::search_path())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd.output().map_err(|e| format!("Could not run git: {e}"))
}
