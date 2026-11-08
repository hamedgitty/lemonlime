//! What a cloud agent may do on this computer, once the window has decided the thread's
//! setting allows it (and asked the user if it should). Paths must be absolute and are
//! never followed through symlinks, so a link can't point a read somewhere else.

use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
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

#[tauri::command]
pub fn computer_read_file(path: String) -> Result<String, String> {
    let p = safe_path(&path)?;
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

#[tauri::command]
pub fn computer_list_dir(path: String) -> Result<String, String> {
    let p = safe_path(&path)?;
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

#[tauri::command]
pub async fn computer_run_command(command: String, cwd: Option<String>) -> Result<String, String> {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn lots_of_error_output_doesnt_stall_and_background_jobs_are_stopped() {
        let started = Instant::now();
        // 300 KB on stderr (more than a pipe holds), then a background job that keeps the pipes open.
        let out = tauri::async_runtime::block_on(computer_run_command(
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
        assert_eq!(computer_read_file(real.to_string_lossy().into()).unwrap(), "hi");
        #[cfg(unix)]
        {
            let link = dir.join("link.txt");
            std::os::unix::fs::symlink(&real, &link).unwrap();
            assert!(computer_read_file(link.to_string_lossy().into()).unwrap_err().contains("symbolic link"));
            assert!(computer_list_dir(dir.to_string_lossy().into()).unwrap().contains("link  link.txt"));
        }
        fs::remove_dir_all(&dir).unwrap();
    }
}
