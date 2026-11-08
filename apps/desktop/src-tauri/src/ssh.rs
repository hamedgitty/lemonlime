//! Threads on another machine of the user's, reached over SSH (a home server, a dev box, a
//! machine on their Tailscale network).
//!
//! The app runs the user's own `ssh` with their own `~/.ssh/config` and agent, in batch mode
//! so it never asks for (or sees) a password or key. The remote runner listens only on the
//! remote machine's loopback, and the app reaches it through an `-L` tunnel bound to this
//! computer's loopback. The thread secret goes over the session's stdin (`--secret-stdin`),
//! never on a command line, where `ps` would show it on either machine.
//!
//! Everything that reaches ssh is checked or quoted here: the host can't start with `-` or
//! hold spaces (so it can't become an ssh option), and every word of the remote command is
//! single-quoted for the remote shell.

use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::paths;
use crate::runner::{self, Probe, RunnerInfo, RunnerProcess, RunnerSettings, Runners};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const DEFAULT_RUNNER: &str = "lemonlime-runner";
const CHECK_TIMEOUT: Duration = Duration::from_secs(25);
const CLEANUP_TIMEOUT: Duration = Duration::from_secs(40);
/// Tries with a different remote port when the one picked is already taken there.
const START_ATTEMPTS: usize = 3;

/// Where to connect: what ssh gets as its destination, and a port when one was given.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct SshTarget {
    pub destination: String,
    pub port: Option<u16>,
}

fn name_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-')
}

/// Reads a host alias from `~/.ssh/config`, `host`, `user@host`, `user@host:port` or
/// `user@[ipv6]:port`. Anything else is refused, so nothing typed here can turn into an ssh
/// option (a leading `-`) or a second argument (spaces, newlines).
pub(crate) fn parse_host(input: &str) -> Result<SshTarget, String> {
    const BAD: &str = "Enter a host from your SSH config, or user@host, optionally with :port.";
    if input.is_empty() || input.len() > 255 {
        return Err(BAD.into());
    }
    if input.starts_with('-') {
        return Err("A host can't start with \"-\".".into());
    }
    if input.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("A host can't contain spaces or line breaks.".into());
    }
    let (user, rest) = match input.split_once('@') {
        Some((u, r)) => (Some(u), r),
        None => (None, input),
    };
    if let Some(u) = user {
        if u.is_empty() || u.starts_with('-') || !u.chars().all(name_char) {
            return Err(BAD.into());
        }
    }
    let (host, port) = if let Some(inner) = rest.strip_prefix('[') {
        let (addr, after) = inner.split_once(']').ok_or(BAD)?;
        if addr.is_empty() || !addr.chars().all(|c| c.is_ascii_hexdigit() || matches!(c, ':' | '.')) {
            return Err(BAD.into());
        }
        let port = match after {
            "" => None,
            p => Some(p.strip_prefix(':').ok_or(BAD)?),
        };
        (addr, port)
    } else {
        match rest.split_once(':') {
            Some((h, p)) => (h, Some(p)),
            None => (rest, None),
        }
    };
    let bracketed = rest.starts_with('[');
    if !bracketed && (host.is_empty() || host.starts_with(['-', '.']) || !host.chars().all(name_char)) {
        return Err(BAD.into());
    }
    let port = match port {
        None => None,
        Some(p) => match p.parse::<u16>() {
            Ok(n) if n > 0 && p.chars().all(|c| c.is_ascii_digit()) => Some(n),
            _ => return Err("The port must be a number from 1 to 65535.".into()),
        },
    };
    let destination = match user {
        Some(u) => format!("{u}@{host}"),
        None => host.to_string(),
    };
    Ok(SshTarget { destination, port })
}

/// Checks a path typed for the other machine (the runner, the project folder).
pub(crate) fn check_remote_path(path: &str, what: &str) -> Result<(), String> {
    if path.is_empty() {
        return Err(format!("Enter the {what} on that machine."));
    }
    if path.len() > 4096 || path.chars().any(|c| c.is_control()) {
        return Err(format!("The {what} can't contain line breaks or control characters."));
    }
    if path.starts_with('-') {
        return Err(format!("The {what} can't start with \"-\"."));
    }
    Ok(())
}

/// Quotes one word for a POSIX shell: as is when it is plainly safe, otherwise in single
/// quotes, with each `'` written as `'\''`.
pub(crate) fn shell_quote(word: &str) -> String {
    if !word.is_empty() && word.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | '/' | '=' | ',' | ':' | '+' | '@')) {
        return word.to_string();
    }
    format!("'{}'", word.replace('\'', "'\\''"))
}

/// A path for the remote shell: quoted, except a leading `~/`, which stays outside the
/// quotes so it still means the remote user's home folder.
pub(crate) fn remote_path_word(path: &str) -> String {
    if path == "~" {
        return "~".into();
    }
    match path.strip_prefix("~/") {
        Some("") => "~/".into(),
        Some(rest) => format!("~/{}", shell_quote(rest)),
        None => shell_quote(path),
    }
}

/// How to run the runner there: a script (`.js`, from a checkout) goes through `node`.
fn runner_invocation(runner_path: &str) -> String {
    let script = [".js", ".mjs", ".cjs"].iter().any(|e| runner_path.to_ascii_lowercase().ends_with(e));
    let word = remote_path_word(runner_path);
    if script {
        format!("node {word}")
    } else {
        word
    }
}

/// The one string ssh hands the remote shell. `exec` makes the runner take the shell's place,
/// so it is a direct child of the ssh session and goes when the session does.
pub(crate) fn remote_runner_command(runner_path: &str, args: &[String], env: &[(&str, &str)]) -> String {
    let mut parts = vec!["exec".to_string()];
    if !env.is_empty() {
        parts.push("env".into());
        parts.extend(env.iter().map(|(k, v)| shell_quote(&format!("{k}={v}"))));
    }
    parts.push(runner_invocation(runner_path));
    parts.extend(args.iter().map(|a| shell_quote(a)));
    parts.join(" ")
}

/// Options every ssh call gets: never prompt, no terminal, no sharing a connection with
/// other sessions (so ending ours really ends it), and the port when one was given.
pub(crate) fn base_args(target: &SshTarget) -> Vec<String> {
    let mut args: Vec<String> = [
        "-T",
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=15",
        "-o",
        "ControlMaster=no",
        "-o",
        "ControlPath=none",
        "-o",
        "PermitLocalCommand=no",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    if let Some(p) = target.port {
        args.push("-p".into());
        args.push(p.to_string());
    }
    args
}

/// ssh arguments that run `remote_command` there with the runner's port tunnelled to
/// 127.0.0.1:`local_port` here. `--` ends ssh's options before the destination, so nothing
/// after it is ever read as one.
pub(crate) fn runner_ssh_args(target: &SshTarget, local_port: u16, remote_port: u16, remote_command: String) -> Vec<String> {
    let mut args = base_args(target);
    for o in ["ExitOnForwardFailure=yes", "ServerAliveInterval=15", "ServerAliveCountMax=3"] {
        args.push("-o".into());
        args.push(o.into());
    }
    args.push("-L".into());
    args.push(format!("127.0.0.1:{local_port}:127.0.0.1:{remote_port}"));
    args.push("--".into());
    args.push(target.destination.clone());
    args.push(remote_command);
    args
}

fn simple_args(target: &SshTarget, remote_command: String) -> Vec<String> {
    let mut args = base_args(target);
    args.push("--".into());
    args.push(target.destination.clone());
    args.push(remote_command);
    args
}

/// What went wrong, in plain words, from ssh's exit code and what it (or the runner) said.
pub(crate) fn explain_failure(host: &str, code: Option<i32>, output: &str) -> String {
    let out = output.trim();
    let has = |s: &str| out.contains(s);
    match code {
        Some(255) if has("Permission denied") => format!(
            "{host} didn't accept your SSH key. LemonLime uses your own SSH keys and agent and never asks for a password: make sure `ssh {host}` works in a terminal without one."
        ),
        Some(255) if has("Host key verification failed") || has("REMOTE HOST IDENTIFICATION HAS CHANGED") => format!(
            "This computer doesn't know {host}'s host key yet, or it changed. Connect once with `ssh {host}` in a terminal to check and accept it."
        ),
        Some(255) if has("Could not resolve hostname") => {
            format!("Couldn't find {host}. Check the name, or add it to your ~/.ssh/config.")
        }
        Some(255) if has("Connection refused") || has("timed out") || has("No route to host") || has("Network is unreachable") => {
            format!("Couldn't reach {host}. Check it is on, connected, and accepting SSH.")
        }
        Some(255) if has("Address already in use") || has("cannot listen to port") => {
            "Couldn't open the tunnel on this computer. Try again.".into()
        }
        Some(255) => format!("Couldn't connect to {host} over SSH:\n{out}"),
        Some(127) => format!(
            "Connected to {host}, but lemonlime-runner isn't installed there, or SSH can't find it on its PATH. Install it there, or put its full path in Settings, Machines."
        ),
        Some(126) => format!("Connected to {host}, but the runner there can't be run. Check the path points to the runner and that it is executable."),
        Some(c) if out.is_empty() => format!("The runner on {host} stopped right away (exit code {c})."),
        Some(c) => format!("The runner on {host} stopped right away (exit code {c}):\n{out}"),
        None => format!("The connection to {host} was stopped."),
    }
}

/// Runs a short ssh command with a time limit; returns its exit code (None when it was
/// stopped) and what it printed, both streams together.
fn run_with_timeout(mut cmd: Command, timeout: Duration) -> Result<(Option<i32>, String, String), String> {
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn().map_err(|e| format!("Could not run ssh: {e}. Is OpenSSH installed?"))?;
    let read = |r: Option<Box<dyn Read + Send>>| {
        thread::spawn(move || {
            let mut buf = Vec::new();
            if let Some(r) = r {
                let _ = r.take(64 * 1024).read_to_end(&mut buf);
            }
            String::from_utf8_lossy(&buf).into_owned()
        })
    };
    let out = read(child.stdout.take().map(|s| Box::new(s) as Box<dyn Read + Send>));
    let err = read(child.stderr.take().map(|s| Box::new(s) as Box<dyn Read + Send>));
    let deadline = Instant::now() + timeout;
    let code = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.code(),
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(100)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    Ok((code, out.join().unwrap_or_default(), err.join().unwrap_or_default()))
}

fn ssh_command(args: &[String]) -> Command {
    let mut cmd = Command::new("ssh");
    cmd.args(args).env("PATH", paths::search_path());
    cmd
}

fn runner_path_or_default(runner_path: Option<String>) -> Result<String, String> {
    let path = runner::non_empty(runner_path).unwrap_or_else(|| DEFAULT_RUNNER.into());
    check_remote_path(&path, "runner path")?;
    Ok(path)
}

#[derive(Serialize)]
pub struct SshCheck {
    ok: bool,
    /// The runner's version there, when it answered.
    version: Option<String>,
    /// What happened, in plain words.
    message: String,
}

/// Settings → Machines → Check: can we log in without a prompt, and does the runner answer?
#[tauri::command]
pub async fn check_ssh_machine(host: String, runner_path: Option<String>) -> Result<SshCheck, String> {
    let target = parse_host(&host)?;
    let runner_path = runner_path_or_default(runner_path)?;
    tauri::async_runtime::spawn_blocking(move || {
        let command = format!("{} --version", runner_invocation(&runner_path));
        let (code, out, err) = run_with_timeout(ssh_command(&simple_args(&target, command)), CHECK_TIMEOUT)?;
        Ok(check_result(&host, code, &out, &err))
    })
    .await
    .map_err(|e| format!("Could not check the machine: {e}"))?
}

fn check_result(host: &str, code: Option<i32>, out: &str, err: &str) -> SshCheck {
    let version = out.lines().find_map(|l| l.trim().strip_prefix("lemonlime-runner ").map(|v| v.trim().to_string()));
    match (code, version) {
        (Some(0), Some(v)) => SshCheck { ok: true, message: format!("Connected to {host}. Runner {v} is ready there."), version: Some(v) },
        (Some(0), None) => SshCheck {
            ok: false,
            version: None,
            message: format!("Connected to {host}, but that path didn't answer like lemonlime-runner. Check the runner path."),
        },
        (None, _) => SshCheck { ok: false, version: None, message: format!("No answer from {host} in {} seconds.", CHECK_TIMEOUT.as_secs()) },
        (code, _) => SshCheck { ok: false, version: None, message: explain_failure(host, code, &format!("{err}\n{out}")) },
    }
}

/// Starts the runner for a thread on another machine over SSH, or returns the one already
/// running. The app then talks to it at ws://127.0.0.1:<port>/ws, like a local runner.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn start_ssh_runner(
    app: AppHandle,
    thread_id: String,
    host: String,
    runner_path: Option<String>,
    agent: String,
    agent_command: Option<String>,
    model: Option<String>,
    reasoning: Option<String>,
    fast: Option<bool>,
    workdir: String,
    base_branch: Option<String>,
    instructions: Option<String>,
    strip_coauthors: Option<bool>,
    branch_prefix: Option<String>,
    retry_max_wait_minutes: Option<f64>,
    disabled_skills: Option<Vec<String>>,
    command_guard: Option<bool>,
) -> Result<RunnerInfo, String> {
    if !runner::valid_thread_id(&thread_id) {
        return Err("That thread id is not valid.".into());
    }
    if !runner::AGENTS.contains(&agent.as_str()) {
        return Err(format!("Unknown agent \"{agent}\"."));
    }
    let agent_command = runner::non_empty(agent_command);
    if agent == "acp" && agent_command.is_none() {
        return Err("ACP agents need a command.".into());
    }
    let target = parse_host(&host)?;
    let runner_path = runner_path_or_default(runner_path)?;
    check_remote_path(&workdir, "project folder")?;
    let settings = RunnerSettings::from_frontend(instructions, strip_coauthors, branch_prefix, retry_max_wait_minutes, disabled_skills, command_guard);

    let mut args: Vec<String> = vec!["--thread".into(), thread_id.clone(), "--agent".into(), agent];
    args.extend(runner::thread_flags(agent_command.as_deref(), model, reasoning, fast.unwrap_or(false), base_branch, &settings));
    // --exit-with-parent: with --secret-stdin, the runner also stops when the session's stdin closes.
    args.extend(["--secret-stdin".into(), "--exit-with-parent".into(), "--host".into(), "127.0.0.1".into()]);
    let env: Vec<(&str, &str)> = settings.instructions.as_deref().map(|i| ("LEMONLIME_INSTRUCTIONS", i)).into_iter().collect();
    let start = SshStart { thread_id, host, target, runner_path, workdir, args, env: env.into_iter().map(|(k, v)| (k, v.to_string())).collect() };
    tauri::async_runtime::spawn_blocking(move || start_blocking(&app, start))
        .await
        .map_err(|e| format!("Could not start the runner: {e}"))?
}

struct SshStart {
    thread_id: String,
    host: String,
    target: SshTarget,
    runner_path: String,
    workdir: String,
    /// Runner flags, without --source-repo and --port (added per attempt).
    args: Vec<String>,
    env: Vec<(&'static str, String)>,
}

/// The remote command for one attempt: the thread works in its own git worktree of the
/// project on that machine, like a local thread.
fn attempt_command(s: &SshStart, remote_port: u16) -> String {
    let env: Vec<(&str, &str)> = s.env.iter().map(|(k, v)| (*k, v.as_str())).collect();
    let mut args = s.args.clone();
    args.extend(["--port".into(), remote_port.to_string()]);
    let mut cmd = remote_runner_command(&s.runner_path, &args, &env);
    // The folder goes last and unquoted at a leading ~/, so it means the remote home.
    cmd.push_str(" --source-repo ");
    cmd.push_str(&remote_path_word(&s.workdir));
    cmd
}

fn start_blocking(app: &AppHandle, s: SshStart) -> Result<RunnerInfo, String> {
    let log_dir = app.path().app_log_dir().map_err(|e| format!("Could not find the log folder: {e}"))?;
    fs::create_dir_all(&log_dir).map_err(|e| format!("Could not create {}: {e}", log_dir.display()))?;
    let log_path = log_dir.join(format!("runner-{}.log", s.thread_id));
    let state = app.state::<Runners>();

    for attempt in 1..=START_ATTEMPTS {
        let log_start = log_len(&log_path);
        let info = {
            let mut runners = state.lock();
            if let Some(existing) = runners.get_mut(&s.thread_id) {
                if existing.alive() {
                    let info = RunnerInfo { port: existing.port, secret: existing.secret.clone() };
                    drop(runners);
                    runner::wait_until_ready(app, &s.thread_id, info.port, &log_path, Probe::Health { host: &s.host })?;
                    return Ok(info);
                }
                runners.remove(&s.thread_id);
            }
            let local_port = runner::free_port()?;
            let remote_port: u16 = rand::random::<u16>() % 30_000 + 20_000;
            let secret = runner::random_secret();
            let log = runner::open_log(&log_path)?;
            let log_err = log.try_clone().map_err(|e| format!("Could not open the runner log: {e}"))?;
            let mut cmd = ssh_command(&runner_ssh_args(&s.target, local_port, remote_port, attempt_command(&s, remote_port)));
            cmd.stdin(Stdio::piped()).stdout(Stdio::from(log)).stderr(Stdio::from(log_err));
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                cmd.creation_flags(CREATE_NO_WINDOW);
            }
            let mut child: Child = cmd.spawn().map_err(|e| format!("Could not run ssh: {e}. Is OpenSSH installed?"))?;
            // The secret goes over the session, the first line the runner reads; the pipe then
            // stays open for as long as the thread runs.
            let mut stdin = child.stdin.take();
            if let Some(pipe) = stdin.as_mut() {
                let _ = pipe.write_all(format!("{secret}\n").as_bytes()).and_then(|_| pipe.flush());
            }
            runners.insert(s.thread_id.clone(), RunnerProcess { child, port: local_port, secret: secret.clone(), log_path: log_path.clone(), stdin });
            RunnerInfo { port: local_port, secret }
        };
        match runner::wait_until_ready(app, &s.thread_id, info.port, &log_path, Probe::Health { host: &s.host }) {
            Ok(()) => return Ok(info),
            // The port picked there was taken: pick another.
            Err(_) if attempt < START_ATTEMPTS && log_since(&log_path, log_start).contains("EADDRINUSE") => continue,
            Err(e) => return Err(e),
        }
    }
    Err(format!("Couldn't find a free port on {}.", s.host))
}

fn log_len(path: &Path) -> u64 {
    fs::metadata(path).map(|m| m.len()).unwrap_or(0)
}

/// What the log gained since `offset` (this attempt's output), at most 64 KB.
fn log_since(path: &Path, offset: u64) -> String {
    let Ok(mut f) = File::open(path) else { return String::new() };
    let _ = f.seek(SeekFrom::Start(offset.saturating_sub(4096)));
    let mut buf = Vec::new();
    let _ = f.take(64 * 1024).read_to_end(&mut buf);
    String::from_utf8_lossy(&buf).into_owned()
}

/// Stops a thread on another machine, then removes its worktree and history there (the
/// branch stays in the project there).
#[tauri::command]
pub async fn remove_ssh_thread(state: State<'_, Runners>, thread_id: String, host: String, runner_path: Option<String>, workdir: String) -> Result<(), String> {
    if !runner::valid_thread_id(&thread_id) {
        return Err("That thread id is not valid.".into());
    }
    let target = parse_host(&host)?;
    let runner_path = runner_path_or_default(runner_path)?;
    check_remote_path(&workdir, "project folder")?;
    let proc = state.lock().remove(&thread_id);
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(p) = proc {
            runner::stop(p);
        }
        let command = format!(
            "{} cleanup --thread {} --source-repo {}",
            runner_invocation(&runner_path),
            shell_quote(&thread_id),
            remote_path_word(&workdir)
        );
        match run_with_timeout(ssh_command(&simple_args(&target, command)), CLEANUP_TIMEOUT)? {
            (Some(0), _, _) => Ok(()),
            (code, out, err) => Err(format!("Could not clean up the thread on {host}. {}", explain_failure(&host, code, &format!("{err}\n{out}")))),
        }
    })
    .await
    .map_err(|e| format!("Could not clean up the thread: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(destination: &str, port: Option<u16>) -> SshTarget {
        SshTarget { destination: destination.into(), port }
    }

    #[test]
    fn reads_the_host_forms_people_type() {
        assert_eq!(parse_host("devbox").unwrap(), t("devbox", None));
        assert_eq!(parse_host("hamed@home-server.local").unwrap(), t("hamed@home-server.local", None));
        assert_eq!(parse_host("me@100.64.0.7:2222").unwrap(), t("me@100.64.0.7", Some(2222)));
        assert_eq!(parse_host("box.tail1234.ts.net:22").unwrap(), t("box.tail1234.ts.net", Some(22)));
        assert_eq!(parse_host("me@[fd7a::1]:2200").unwrap(), t("me@fd7a::1", Some(2200)));
        assert_eq!(parse_host("[::1]").unwrap(), t("::1", None));
    }

    #[test]
    fn refuses_hosts_that_could_become_ssh_options_or_extra_arguments() {
        for bad in [
            "",
            "-oProxyCommand=touch /tmp/x",
            "-p",
            "host -oProxyCommand=x",
            "host\n-oProxyCommand=x",
            "host\tx",
            "me@-oProxyCommand=x",
            "-me@host",
            "me@host:0",
            "me@host:99999",
            "me@host:22x",
            "me@host:",
            "a@b@c",
            "host;rm -rf ~",
            "$(whoami)@host",
            "`id`",
            "host'quote",
            ".hidden",
            "me@[fd7a::1",
            "me@[zz]:22",
            "host:22:33",
        ] {
            assert!(parse_host(bad).is_err(), "should refuse {bad:?}");
        }
    }

    #[test]
    fn quotes_words_for_the_remote_shell() {
        assert_eq!(shell_quote("plain-word_1.2/x"), "plain-word_1.2/x");
        assert_eq!(shell_quote(""), "''");
        assert_eq!(shell_quote("has space"), "'has space'");
        assert_eq!(shell_quote("it's"), "'it'\\''s'");
        assert_eq!(shell_quote("$(rm -rf ~)"), "'$(rm -rf ~)'");
        assert_eq!(shell_quote("a;b|c&d`e`\"f\"\\g"), "'a;b|c&d`e`\"f\"\\g'");
        assert_eq!(shell_quote("~/x"), "'~/x'");
    }

    #[test]
    fn keeps_a_leading_home_folder_outside_the_quotes() {
        assert_eq!(remote_path_word("~/code/my app"), "~/'code/my app'");
        assert_eq!(remote_path_word("~/"), "~/");
        assert_eq!(remote_path_word("~"), "~");
        assert_eq!(remote_path_word("~other/x"), "'~other/x'");
        assert_eq!(remote_path_word("/srv/it's here"), "'/srv/it'\\''s here'");
    }

    /// What a POSIX shell makes of a command line, run for real.
    #[cfg(unix)]
    fn words_after_shell(line: &str) -> Vec<String> {
        let out = Command::new("sh")
            .arg("-c")
            .arg(format!("for w in {line}; do printf '%s\\0' \"$w\"; done"))
            .env("HOME", "/home/someone")
            .output()
            .unwrap();
        String::from_utf8(out.stdout).unwrap().split('\0').filter(|s| !s.is_empty()).map(String::from).collect()
    }

    #[cfg(unix)]
    #[test]
    fn quoted_words_come_back_unchanged_from_a_real_shell() {
        let words = ["plain", "two words", "it's", "\"double\"", "$HOME", "`id`", "a\\b", "semi;colon", "*", "--flag=x y"];
        let line: Vec<String> = words.iter().map(|w| shell_quote(w)).collect();
        assert_eq!(words_after_shell(&line.join(" ")), words);
        assert_eq!(words_after_shell(&remote_path_word("~/my 'project'")), ["/home/someone/my 'project'"]);
    }

    #[test]
    fn builds_the_remote_runner_command() {
        let args: Vec<String> = ["--thread", "abc123", "--model", "it's big"].iter().map(|s| s.to_string()).collect();
        assert_eq!(
            remote_runner_command("lemonlime-runner", &args, &[]),
            "exec lemonlime-runner --thread abc123 --model 'it'\\''s big'"
        );
        assert_eq!(
            remote_runner_command("~/lemonlime/packages/runner/bin/lemonlime-runner.js", &[], &[("LEMONLIME_INSTRUCTIONS", "Be brief; don't guess")]),
            "exec env 'LEMONLIME_INSTRUCTIONS=Be brief; don'\\''t guess' node ~/lemonlime/packages/runner/bin/lemonlime-runner.js"
        );
        assert_eq!(remote_runner_command("/opt/my tools/lemonlime-runner", &[], &[]), "exec '/opt/my tools/lemonlime-runner'");
    }

    #[test]
    fn never_puts_the_secret_on_the_command_line() {
        let s = SshStart {
            thread_id: "abc123".into(),
            host: "devbox".into(),
            target: t("devbox", None),
            runner_path: "lemonlime-runner".into(),
            workdir: "~/my code/app".into(),
            args: vec!["--thread".into(), "abc123".into(), "--secret-stdin".into()],
            env: vec![],
        };
        let cmd = attempt_command(&s, 41234);
        assert_eq!(cmd, "exec lemonlime-runner --thread abc123 --secret-stdin --port 41234 --source-repo ~/'my code/app'");
        let args = runner_ssh_args(&s.target, 5000, 41234, cmd);
        assert!(!args.iter().any(|a| a.contains("SECRET") || a.contains("secret=")));
    }

    #[test]
    fn builds_the_ssh_arguments() {
        let args = runner_ssh_args(&t("me@box", Some(2222)), 5000, 41234, "exec lemonlime-runner".into());
        let joined = args.join(" ");
        assert!(joined.contains("-o BatchMode=yes"));
        assert!(joined.contains("-o ExitOnForwardFailure=yes"));
        assert!(joined.contains("-p 2222"));
        assert!(joined.contains("-L 127.0.0.1:5000:127.0.0.1:41234"));
        // The destination comes straight after "--", and the remote command is one argument after it.
        let dash = args.iter().position(|a| a == "--").unwrap();
        assert_eq!(&args[dash + 1..], ["me@box", "exec lemonlime-runner"]);
        assert!(!args[..dash].iter().any(|a| a == "me@box"));

        let plain = base_args(&t("box", None));
        assert!(!plain.contains(&"-p".to_string()));
    }

    #[test]
    fn checks_remote_paths() {
        assert!(check_remote_path("~/code/my app", "project folder").is_ok());
        assert!(check_remote_path("/srv/it's", "project folder").is_ok());
        assert!(check_remote_path("", "project folder").is_err());
        assert!(check_remote_path("-rf", "project folder").is_err());
        assert!(check_remote_path("a\nb", "project folder").is_err());
        assert!(check_remote_path("a\0b", "project folder").is_err());
    }

    #[test]
    fn explains_failures_plainly() {
        assert!(explain_failure("box", Some(255), "me@box: Permission denied (publickey).").contains("didn't accept your SSH key"));
        assert!(explain_failure("box", Some(255), "Host key verification failed.").contains("host key"));
        assert!(explain_failure("box", Some(255), "ssh: Could not resolve hostname box").contains("Couldn't find box"));
        assert!(explain_failure("box", Some(255), "connect to host box port 22: Connection refused").contains("Couldn't reach box"));
        assert!(explain_failure("box", Some(127), "sh: lemonlime-runner: command not found").contains("isn't installed there"));
        let check = check_result("box", Some(0), "lemonlime-runner 0.1.0\n", "");
        assert!(check.ok);
        assert_eq!(check.version.as_deref(), Some("0.1.0"));
        assert!(!check_result("box", Some(0), "hello\n", "").ok);
        assert!(!check_result("box", None, "", "").ok);
    }
}
