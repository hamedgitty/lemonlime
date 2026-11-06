//! Finding programs. Apps started from a desktop launcher often get a much
//! shorter PATH than a terminal, so we widen it with the user's login-shell PATH
//! and a few common install locations before looking up `lemonlime-runner`,
//! `git` or the agent CLIs.

use std::env;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

#[cfg(unix)]
use std::{
    process::{Command, Stdio},
    sync::mpsc,
    thread,
    time::Duration,
};

static SEARCH_PATH: OnceLock<OsString> = OnceLock::new();

/// PATH handed to child processes and used for lookups. Computed once.
pub fn search_path() -> &'static OsString {
    SEARCH_PATH.get_or_init(build_search_path)
}

fn build_search_path() -> OsString {
    let mut dirs: Vec<PathBuf> = Vec::new();
    let mut push = |p: PathBuf| {
        if !p.as_os_str().is_empty() && !dirs.contains(&p) {
            dirs.push(p);
        }
    };

    if let Some(current) = env::var_os("PATH") {
        for p in env::split_paths(&current) {
            push(p);
        }
    }

    #[cfg(unix)]
    if let Some(login) = login_shell_path() {
        for p in env::split_paths(&login) {
            push(p);
        }
    }

    for p in extra_dirs() {
        push(p);
    }

    env::join_paths(&dirs).unwrap_or_else(|_| env::var_os("PATH").unwrap_or_default())
}

fn home_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    let home = env::var_os("USERPROFILE");
    #[cfg(not(windows))]
    let home = env::var_os("HOME");
    home.map(PathBuf::from).filter(|p| !p.as_os_str().is_empty())
}

fn extra_dirs() -> Vec<PathBuf> {
    let mut out = Vec::new();
    #[cfg(unix)]
    {
        out.push(PathBuf::from("/opt/homebrew/bin"));
        out.push(PathBuf::from("/usr/local/bin"));
        if let Some(home) = home_dir() {
            for rel in [".local/bin", ".npm-global/bin", ".volta/bin", ".bun/bin", ".cargo/bin", "bin"] {
                out.push(home.join(rel));
            }
        }
    }
    #[cfg(windows)]
    {
        if let Some(appdata) = env::var_os("APPDATA") {
            out.push(PathBuf::from(appdata).join("npm"));
        }
        if let Some(home) = home_dir() {
            out.push(home.join(".bun").join("bin"));
            out.push(home.join(".cargo").join("bin"));
        }
    }
    out
}

/// Asks the user's login shell for its PATH, giving up after a few seconds.
#[cfg(unix)]
fn login_shell_path() -> Option<OsString> {
    const MARK: &str = "__LEMONLIME_PATH__";
    let shell = env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/bin/sh".into());
    let child = Command::new(shell)
        .arg("-ilc")
        .arg(format!("printf '%s%s%s' '{MARK}' \"$PATH\" '{MARK}'"))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let pid = child.id();

    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let _ = tx.send(child.wait_with_output());
    });

    match rx.recv_timeout(Duration::from_secs(4)) {
        Ok(Ok(output)) => {
            let text = String::from_utf8_lossy(&output.stdout);
            let start = text.find(MARK)? + MARK.len();
            let end = start + text[start..].find(MARK)?;
            let path = text[start..end].trim();
            (!path.is_empty()).then(|| OsString::from(path))
        }
        _ => {
            // The shell is stuck (e.g. waiting on a prompt); stop it and move on.
            unsafe {
                libc::kill(pid as libc::pid_t, libc::SIGKILL);
            }
            None
        }
    }
}

/// Expands a leading `~` to the home directory.
pub fn expand_home(input: &str) -> PathBuf {
    if input == "~" {
        return home_dir().unwrap_or_else(|| PathBuf::from(input));
    }
    if let Some(rest) = input.strip_prefix("~/").or_else(|| input.strip_prefix("~\\")) {
        if let Some(home) = home_dir() {
            return home.join(rest);
        }
    }
    PathBuf::from(input)
}

/// Looks a program up by name on the widened PATH (honouring PATHEXT on Windows).
pub fn find_program(name: &str) -> Option<PathBuf> {
    for dir in env::split_paths(search_path()) {
        for candidate in candidates(&dir, name) {
            if is_executable(&candidate) {
                return Some(candidate);
            }
        }
    }
    None
}

#[cfg(windows)]
fn candidates(dir: &Path, name: &str) -> Vec<PathBuf> {
    let base = dir.join(name);
    if Path::new(name).extension().is_some() {
        return vec![base];
    }
    let exts = env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into());
    exts.split(';')
        .filter(|e| !e.is_empty())
        .map(|e| dir.join(format!("{name}{}", e.to_ascii_lowercase())))
        .collect()
}

#[cfg(not(windows))]
fn candidates(dir: &Path, name: &str) -> Vec<PathBuf> {
    vec![dir.join(name)]
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.metadata()
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(path: &Path) -> bool {
    path.is_file()
}

/// Resolves a user setting that may be a bare program name or a path.
pub fn resolve_program(setting: Option<&str>, default_name: &str) -> Result<PathBuf, String> {
    let wanted = setting.map(str::trim).filter(|s| !s.is_empty());
    match wanted {
        None => find_program(default_name).ok_or_else(|| {
            format!("Could not find {default_name} on your PATH. Install it, or set its location in Settings.")
        }),
        Some(value) => {
            let looks_like_path = value.contains('/') || value.contains('\\') || value.starts_with('~');
            if looks_like_path {
                let path = expand_home(value);
                if path.is_file() {
                    Ok(path)
                } else {
                    Err(format!("No runner found at {}. Check the path in Settings.", path.display()))
                }
            } else {
                find_program(value)
                    .ok_or_else(|| format!("Could not find {value} on your PATH. Check the runner setting."))
            }
        }
    }
}
