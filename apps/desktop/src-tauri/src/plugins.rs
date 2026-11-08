//! Agent plugins: folders (or git repositories) in the widely used plugin layout that
//! bundle skills, slash commands, subagent definitions, MCP servers and hooks:
//!
//! ```text
//! .claude-plugin/plugin.json   name, description, version, author, homepage
//! skills/<name>/SKILL.md       commands/*.md   agents/*.md   .mcp.json   hooks/hooks.json
//! ```
//!
//! They are installed into `~/.lemonlime/plugins/<name>/` (or `$LEMONLIME_HOME/plugins`),
//! with `plugins.json` recording where each came from and whether it is turned on. The
//! runner reads that folder (`--plugins-dir`) and puts the enabled plugins into each new
//! local thread. A marketplace repository (`.claude-plugin/marketplace.json`) installs every
//! plugin it lists from its own folders, or one picked by name, even from another repository.
//! Hooks are listed but never applied.
//!
//! Not to be confused with `packages/plugins`, the hosted-deployment hooks.

use std::collections::BTreeSet;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use rand::Rng;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::paths;

/// Limits a plugin must stay within: it is read on every thread start and partly copied in.
const MAX_FILE_BYTES: u64 = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 50 * 1024 * 1024;
const MAX_FILES: u64 = 5000;
const MAX_DEPTH: usize = 16;
const MAX_JSON_BYTES: u64 = 1024 * 1024;
const MAX_README_BYTES: usize = 256 * 1024;
/// Most plugins one marketplace may install at once.
const MAX_MARKETPLACE_PLUGINS: usize = 100;
const GIT_TIMEOUT: Duration = Duration::from_secs(180);

const REGISTRY_FILE: &str = "plugins.json";
/// Scratch space inside the plugins folder, so finished installs are a rename away.
const TMP_DIR: &str = ".tmp";

/// Registry changes happen one at a time.
static REGISTRY_LOCK: Mutex<()> = Mutex::new(());

pub fn plugins_dir() -> Option<PathBuf> {
    if let Some(home) = std::env::var_os("LEMONLIME_HOME").filter(|v| !v.is_empty()) {
        return Some(PathBuf::from(home).join("plugins"));
    }
    #[cfg(windows)]
    let home = std::env::var_os("USERPROFILE");
    #[cfg(not(windows))]
    let home = std::env::var_os("HOME");
    home.filter(|h| !h.is_empty()).map(|h| PathBuf::from(h).join(".lemonlime").join("plugins"))
}

fn require_dir() -> Result<PathBuf, String> {
    let dir = plugins_dir().ok_or("Couldn't find your home folder.")?;
    fs::create_dir_all(&dir).map_err(|e| format!("Couldn't create {}: {e}", dir.display()))?;
    Ok(dir)
}

// ---------------------------------------------------------------------------------------
// Validation

/// A plugin's name, which is also its folder name.
pub fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name.chars().next().is_some_and(|c| c.is_ascii_alphanumeric())
        && !name.contains("..")
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
}

/// A file or folder name for a skill, command or agent.
fn valid_segment(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 100
        && name.chars().next().is_some_and(|c| c.is_ascii_alphanumeric() || c == '_')
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
}

fn valid_server_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 64 && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
}

/// A relative path that stays inside the folder it is relative to.
pub fn safe_relative(p: &str) -> bool {
    if p.is_empty() || p.len() > 500 || p.contains('\0') || p.contains('\\') || p.starts_with('/') {
        return false;
    }
    let b = p.as_bytes();
    if b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':' {
        return false;
    }
    p.split('/').all(|s| s != "..")
}

/// `root/rel`, refusing anything that leaves `root`.
fn inside(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let clean = rel.trim_start_matches("./");
    if !safe_relative(clean) {
        return Err(format!("{rel} points outside the plugin."));
    }
    Ok(root.join(clean))
}

/// Only plain https URLs: no credentials in them (they'd be saved in plugins.json), no other
/// transports.
pub fn valid_git_url(url: &str) -> Result<(), String> {
    let Some(rest) = url.strip_prefix("https://") else {
        return Err("Use an https:// link to the repository.".into());
    };
    if url.len() > 500 || url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("That link has spaces or other characters a repository link can't have.".into());
    }
    let host = rest.split('/').next().unwrap_or("");
    if host.is_empty() || (!host.contains('.') && host != "localhost") {
        return Err("That link has no server name.".into());
    }
    if host.contains('@') {
        return Err("Leave sign-in details out of the link; git asks for them if the repository is private.".into());
    }
    if rest.len() <= host.len() + 1 {
        return Err("That link has no repository path.".into());
    }
    Ok(())
}

/// A branch or tag name.
pub fn valid_ref(r: &str) -> bool {
    !r.is_empty()
        && r.len() <= 200
        && r.chars().next().is_some_and(|c| c.is_ascii_alphanumeric())
        && !r.contains("..")
        && !r.ends_with('/')
        && !r.ends_with(".lock")
        && r.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | '/'))
}

/// Walk a plugin folder, refusing links (they could point anywhere), oversize files, too many
/// files and deep nesting. A `.git` folder at the top is skipped; it is never copied.
pub fn check_tree(root: &Path) -> Result<(u64, u64), String> {
    let mut files = 0;
    let mut bytes = 0;
    walk_tree(root, root, 0, &mut files, &mut bytes)?;
    Ok((files, bytes))
}

fn walk_tree(root: &Path, dir: &Path, depth: usize, files: &mut u64, bytes: &mut u64) -> Result<(), String> {
    if depth > MAX_DEPTH {
        return Err(format!("{} is nested too deeply.", rel_display(root, dir)));
    }
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if depth == 0 && entry.file_name() == ".git" {
            continue;
        }
        let path = entry.path();
        let meta = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
        let kind = meta.file_type();
        if kind.is_symlink() {
            return Err(format!("{} is a link; plugins can't contain links.", rel_display(root, &path)));
        }
        if kind.is_dir() {
            walk_tree(root, &path, depth + 1, files, bytes)?;
        } else if kind.is_file() {
            if meta.len() > MAX_FILE_BYTES {
                return Err(format!("{} is over 5 MB.", rel_display(root, &path)));
            }
            *files += 1;
            *bytes += meta.len();
            if *files > MAX_FILES {
                return Err(format!("The plugin has more than {MAX_FILES} files."));
            }
            if *bytes > MAX_TOTAL_BYTES {
                return Err("The plugin is over 50 MB.".into());
            }
        } else {
            return Err(format!("{} isn't a regular file or folder.", rel_display(root, &path)));
        }
    }
    Ok(())
}

fn rel_display(root: &Path, path: &Path) -> String {
    path.strip_prefix(root).unwrap_or(path).to_string_lossy().replace('\\', "/")
}

fn read_json(path: &Path, label: &str) -> Result<Value, String> {
    let meta = fs::symlink_metadata(path).map_err(|e| format!("Couldn't read {label}: {e}"))?;
    if !meta.is_file() {
        return Err(format!("{label} isn't a file."));
    }
    if meta.len() > MAX_JSON_BYTES {
        return Err(format!("{label} is over 1 MB."));
    }
    let text = fs::read_to_string(path).map_err(|e| format!("Couldn't read {label}: {e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("{label} isn't valid JSON: {e}"))
}

/// What plugin.json says, checked.
#[derive(Debug, Clone)]
pub struct Manifest {
    pub name: String,
    pub description: String,
    pub version: Option<String>,
    pub author: Option<String>,
    pub homepage: Option<String>,
    pub license: Option<String>,
    raw: Map<String, Value>,
}

fn opt_string(obj: &Map<String, Value>, key: &str, max: usize) -> Result<Option<String>, String> {
    match obj.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) if s.len() <= max => Ok(Some(s.clone())),
        Some(Value::String(_)) => Err(format!("plugin.json: {key} is too long.")),
        Some(_) => Err(format!("plugin.json: {key} must be text.")),
    }
}

/// Paths a manifest field lists: a string or a list of strings, each inside the plugin.
fn path_list(obj: &Map<String, Value>, key: &str) -> Result<Vec<String>, String> {
    let list = match obj.get(key) {
        None | Some(Value::Null) => return Ok(Vec::new()),
        Some(Value::String(s)) => vec![s.clone()],
        Some(Value::Array(a)) if a.len() <= 50 => a
            .iter()
            .map(|v| v.as_str().map(str::to_string).ok_or(format!("plugin.json: {key} must list paths.")))
            .collect::<Result<_, _>>()?,
        Some(_) => return Err(format!("plugin.json: {key} must be a path or a list of paths.")),
    };
    for p in &list {
        if !safe_relative(p.trim_start_matches("./")) {
            return Err(format!("plugin.json: {p} points outside the plugin."));
        }
    }
    Ok(list)
}

pub fn parse_manifest(value: Value) -> Result<Manifest, String> {
    let Value::Object(obj) = value else { return Err("plugin.json must be an object.".into()) };
    let name = obj.get("name").and_then(Value::as_str).ok_or("plugin.json has no name.")?.to_string();
    if !valid_name(&name) {
        return Err("plugin.json: the name must be letters, numbers, dots, dashes or underscores (at most 64).".into());
    }
    let author = match obj.get("author") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(s.clone()),
        Some(Value::Object(a)) => Some(a.get("name").and_then(Value::as_str).ok_or("plugin.json: author needs a name.")?.to_string()),
        Some(_) => return Err("plugin.json: author must be text or {\"name\": ...}.".into()),
    };
    if author.as_ref().is_some_and(|a| a.len() > 200) {
        return Err("plugin.json: author is too long.".into());
    }
    for key in ["commands", "agents", "skills"] {
        path_list(&obj, key)?;
    }
    for key in ["hooks", "mcpServers"] {
        match obj.get(key) {
            None | Some(Value::Null) | Some(Value::Object(_)) => {}
            Some(Value::String(s)) if safe_relative(s.trim_start_matches("./")) => {}
            Some(Value::String(s)) => return Err(format!("plugin.json: {s} points outside the plugin.")),
            Some(_) => return Err(format!("plugin.json: {key} must be a path or an object.")),
        }
    }
    Ok(Manifest {
        description: opt_string(&obj, "description", 2000)?.unwrap_or_default(),
        version: opt_string(&obj, "version", 64)?,
        homepage: opt_string(&obj, "homepage", 500)?,
        license: opt_string(&obj, "license", 100)?,
        author,
        name,
        raw: obj,
    })
}

/// What a plugin gives the agents.
#[derive(Serialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PluginContents {
    pub skills: Vec<String>,
    pub commands: Vec<String>,
    pub agents: Vec<String>,
    pub mcp_servers: Vec<String>,
    /// Hook events it defines. LemonLime never runs them.
    pub hooks: Vec<String>,
    pub hooks_applied: bool,
}

fn skill_folders(dir: &Path, out: &mut BTreeSet<String>) {
    if !dir.is_dir() {
        return;
    }
    if dir.join("SKILL.md").is_file() {
        if let Some(n) = dir.file_name().map(|n| n.to_string_lossy().to_string()).filter(|n| valid_segment(n)) {
            out.insert(n);
        }
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if valid_segment(&name) && e.path().is_dir() && e.path().join("SKILL.md").is_file() {
            out.insert(name);
        }
    }
}

fn markdown_files(path: &Path, prefix: &str, out: &mut BTreeSet<String>) {
    if path.is_file() {
        let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        if let Some(stem) = name.strip_suffix(".md").filter(|s| !s.is_empty() && valid_segment(&name)) {
            out.insert(format!("{prefix}{stem}"));
        }
        return;
    }
    let Ok(entries) = fs::read_dir(path) else { return };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if !valid_segment(&name) {
            continue;
        }
        let p = e.path();
        if p.is_dir() {
            markdown_files(&p, &format!("{prefix}{name}/"), out);
        } else if let Some(stem) = name.strip_suffix(".md").filter(|s| !s.is_empty()) {
            out.insert(format!("{prefix}{stem}"));
        }
    }
}

fn add_servers(value: &Value, label: &str, out: &mut BTreeSet<String>) -> Result<(), String> {
    let servers = match value.get("mcpServers") {
        Some(Value::Object(m)) => m,
        Some(_) => return Err(format!("{label}: mcpServers must be an object.")),
        None => value.as_object().ok_or(format!("{label} must be an object."))?,
    };
    if servers.len() > 50 {
        return Err(format!("{label}: a plugin can bring at most 50 MCP servers."));
    }
    for (name, server) in servers {
        if !valid_server_name(name) {
            return Err(format!("{label}: the MCP server name \"{name}\" must be letters, numbers, dashes or underscores."));
        }
        let command = server.get("command").and_then(Value::as_str).filter(|c| !c.is_empty());
        let url = server.get("url").and_then(Value::as_str);
        match (command, url) {
            (Some(_), _) => {}
            (None, Some(u)) if u.starts_with("https://") || u.starts_with("http://") => {}
            _ => return Err(format!("{label}: the MCP server \"{name}\" needs a command or an http(s) url.")),
        }
    }
    out.extend(servers.keys().cloned());
    Ok(())
}

fn add_hooks(value: &Value, label: &str, out: &mut BTreeSet<String>) -> Result<(), String> {
    let events = match value.get("hooks") {
        Some(Value::Object(m)) => m,
        Some(_) => return Err(format!("{label}: hooks must be an object.")),
        None => value.as_object().ok_or(format!("{label} must be an object."))?,
    };
    out.extend(events.keys().filter(|k| k.as_str() != "description").cloned());
    Ok(())
}

/// Read and check a plugin folder: its manifest, what it gives, and its README.
pub fn inspect(root: &Path) -> Result<(Manifest, PluginContents, Option<String>), String> {
    if !root.is_dir() {
        return Err(format!("{} isn't a folder.", root.display()));
    }
    check_tree(root)?;
    let manifest_path = root.join(".claude-plugin").join("plugin.json");
    if !manifest_path.is_file() {
        return Err("There's no .claude-plugin/plugin.json, so this isn't a plugin.".into());
    }
    let manifest = parse_manifest(read_json(&manifest_path, "plugin.json")?)?;
    let raw = &manifest.raw;

    let mut skills = BTreeSet::new();
    skill_folders(&root.join("skills"), &mut skills);
    for p in path_list(raw, "skills")? {
        skill_folders(&inside(root, &p)?, &mut skills);
    }
    let mut commands = BTreeSet::new();
    markdown_files(&root.join("commands"), "", &mut commands);
    for p in path_list(raw, "commands")? {
        markdown_files(&inside(root, &p)?, "", &mut commands);
    }
    let mut agents = BTreeSet::new();
    markdown_files(&root.join("agents"), "", &mut agents);
    for p in path_list(raw, "agents")? {
        markdown_files(&inside(root, &p)?, "", &mut agents);
    }

    let mut servers = BTreeSet::new();
    if root.join(".mcp.json").is_file() {
        add_servers(&read_json(&root.join(".mcp.json"), ".mcp.json")?, ".mcp.json", &mut servers)?;
    }
    match raw.get("mcpServers") {
        Some(Value::String(p)) => add_servers(&read_json(&inside(root, p)?, p)?, p, &mut servers)?,
        Some(v @ Value::Object(_)) => add_servers(v, "plugin.json mcpServers", &mut servers)?,
        _ => {}
    }

    let mut hooks = BTreeSet::new();
    let hooks_file = root.join("hooks").join("hooks.json");
    if hooks_file.is_file() {
        add_hooks(&read_json(&hooks_file, "hooks/hooks.json")?, "hooks/hooks.json", &mut hooks)?;
    }
    match raw.get("hooks") {
        Some(Value::String(p)) => add_hooks(&read_json(&inside(root, p)?, p)?, p, &mut hooks)?,
        Some(v @ Value::Object(_)) => add_hooks(v, "plugin.json hooks", &mut hooks)?,
        _ => {}
    }

    let readme = fs::read_dir(root).ok().and_then(|entries| {
        entries
            .flatten()
            .find(|e| e.file_name().to_string_lossy().eq_ignore_ascii_case("readme.md"))
            .and_then(|e| {
                let mut buf = Vec::new();
                fs::File::open(e.path()).ok()?.take(MAX_README_BYTES as u64).read_to_end(&mut buf).ok()?;
                Some(String::from_utf8_lossy(&buf).to_string())
            })
    });

    let contents = PluginContents {
        skills: skills.into_iter().collect(),
        commands: commands.into_iter().collect(),
        agents: agents.into_iter().collect(),
        mcp_servers: servers.into_iter().collect(),
        hooks: hooks.into_iter().collect(),
        hooks_applied: false,
    };
    Ok((manifest, contents, readme))
}

// ---------------------------------------------------------------------------------------
// Registry

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PluginRecord {
    pub name: String,
    /// An https git URL or a local folder path.
    pub source: String,
    #[serde(default)]
    pub version: Option<String>,
    pub enabled: bool,
    pub installed_at: String,
    pub updated_at: String,
    #[serde(default)]
    pub commit: Option<String>,
    /// The branch or tag asked for, if any.
    #[serde(default, rename = "ref", skip_serializing_if = "Option::is_none")]
    pub git_ref: Option<String>,
    /// The plugin's folder inside the source (marketplace repositories).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Default)]
struct Registry {
    plugins: Vec<PluginRecord>,
}

fn read_registry(dir: &Path) -> Result<Registry, String> {
    let file = dir.join(REGISTRY_FILE);
    if !file.exists() {
        return Ok(Registry::default());
    }
    let value = read_json(&file, REGISTRY_FILE)?;
    let reg: Registry = serde_json::from_value(value).map_err(|e| format!("{REGISTRY_FILE} isn't valid: {e}"))?;
    Ok(Registry { plugins: reg.plugins.into_iter().filter(|p| valid_name(&p.name)).collect() })
}

fn write_registry(dir: &Path, reg: &Registry) -> Result<(), String> {
    let text = serde_json::to_string_pretty(reg).map_err(|e| e.to_string())?;
    let tmp = dir.join(format!("{REGISTRY_FILE}.tmp"));
    fs::write(&tmp, text + "\n").map_err(|e| format!("Couldn't save {REGISTRY_FILE}: {e}"))?;
    fs::rename(&tmp, dir.join(REGISTRY_FILE)).map_err(|e| format!("Couldn't save {REGISTRY_FILE}: {e}"))
}

fn lock() -> std::sync::MutexGuard<'static, ()> {
    REGISTRY_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

/// Now, as an ISO 8601 UTC timestamp.
pub fn now_iso() -> String {
    iso_from_unix(SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0))
}

/// Seconds since 1970 as `YYYY-MM-DDTHH:MM:SSZ` (days-to-civil, proleptic Gregorian).
pub fn iso_from_unix(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

// ---------------------------------------------------------------------------------------
// What the app sees

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PluginSummary {
    name: String,
    description: String,
    version: Option<String>,
    author: Option<String>,
    homepage: Option<String>,
    source: String,
    /// "git" or "folder".
    source_kind: &'static str,
    #[serde(rename = "ref")]
    git_ref: Option<String>,
    enabled: bool,
    installed_at: String,
    updated_at: String,
    commit: Option<String>,
    contents: PluginContents,
    /// Set when the installed folder can't be read any more.
    problem: Option<String>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PluginDetail {
    #[serde(flatten)]
    summary: PluginSummary,
    license: Option<String>,
    readme: Option<String>,
}

fn source_kind(source: &str) -> &'static str {
    if source.starts_with("https://") {
        "git"
    } else {
        "folder"
    }
}

fn summarize(dir: &Path, rec: &PluginRecord) -> (PluginSummary, Option<Manifest>, Option<String>) {
    let inspected = inspect(&dir.join(&rec.name));
    let (manifest, contents, readme, problem) = match inspected {
        Ok((m, c, r)) => (Some(m), c, r, None),
        Err(e) => (None, PluginContents::default(), None, Some(e)),
    };
    let summary = PluginSummary {
        name: rec.name.clone(),
        description: manifest.as_ref().map(|m| m.description.clone()).unwrap_or_default(),
        version: rec.version.clone().or_else(|| manifest.as_ref().and_then(|m| m.version.clone())),
        author: manifest.as_ref().and_then(|m| m.author.clone()),
        homepage: manifest.as_ref().and_then(|m| m.homepage.clone()).filter(|h| h.starts_with("https://") || h.starts_with("http://")),
        source: rec.source.clone(),
        source_kind: source_kind(&rec.source),
        git_ref: rec.git_ref.clone(),
        enabled: rec.enabled,
        installed_at: rec.installed_at.clone(),
        updated_at: rec.updated_at.clone(),
        commit: rec.commit.clone(),
        contents,
        problem,
    };
    (summary, manifest, readme)
}

pub fn list_in(dir: &Path) -> Result<Vec<PluginSummary>, String> {
    let reg = read_registry(dir)?;
    let mut out: Vec<PluginSummary> = reg.plugins.iter().map(|r| summarize(dir, r).0).collect();
    out.sort_by_key(|p| p.name.to_lowercase());
    Ok(out)
}

pub fn read_in(dir: &Path, name: &str) -> Result<PluginDetail, String> {
    let reg = read_registry(dir)?;
    let rec = reg.plugins.iter().find(|p| p.name == name).ok_or(format!("There's no plugin called {name}."))?;
    let (summary, manifest, readme) = summarize(dir, rec);
    Ok(PluginDetail { license: manifest.and_then(|m| m.license), readme, summary })
}

// ---------------------------------------------------------------------------------------
// Installing

/// A scratch folder inside the plugins folder, removed when dropped.
struct Scratch(PathBuf);

impl Scratch {
    fn new(dir: &Path) -> Result<Self, String> {
        let id: u64 = rand::thread_rng().gen();
        let path = dir.join(TMP_DIR).join(format!("{id:016x}"));
        fs::create_dir_all(&path).map_err(|e| format!("Couldn't create {}: {e}", path.display()))?;
        Ok(Scratch(path))
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// Copy a folder that `check_tree` accepted, leaving out a top-level `.git`.
fn copy_plugin(from: &Path, to: &Path, top: bool) -> Result<(), String> {
    fs::create_dir_all(to).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(from).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if top && entry.file_name() == ".git" {
            continue;
        }
        let kind = entry.file_type().map_err(|e| e.to_string())?;
        let target = to.join(entry.file_name());
        if kind.is_symlink() {
            return Err(format!("{} is a link; plugins can't contain links.", entry.path().display()));
        } else if kind.is_dir() {
            copy_plugin(&entry.path(), &target, false)?;
        } else {
            fs::copy(entry.path(), &target).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// One plugin found in a source: its folder, where that is inside the source, and the
/// marketplace entry describing it (used as its manifest when it has no plugin.json).
struct Candidate {
    name: String,
    folder: PathBuf,
    subpath: Option<String>,
    entry: Option<Map<String, Value>>,
}

/// A plugin a marketplace lists from another git repository (`url`, `git-subdir` or
/// `github` sources). Only followed when the person picked that plugin by name.
struct Remote {
    name: String,
    url: String,
    path: Option<String>,
    git_ref: Option<String>,
    sha: Option<String>,
    entry: Map<String, Value>,
}

/// Where a marketplace entry's plugin lives when it isn't in the marketplace's own repository.
fn remote_source(name: &str, entry: &Map<String, Value>) -> Option<Result<Remote, String>> {
    let source = entry.get("source")?;
    let text = |v: &Value, key: &str| v.get(key).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);
    let (url, path, git_ref, sha) = match source {
        Value::String(s) if s.contains("://") => (s.trim().to_string(), None, None, None),
        Value::Object(o) => {
            let v = Value::Object(o.clone());
            let url = match o.get("source").and_then(Value::as_str) {
                Some("url") | Some("git-subdir") => text(&v, "url")?,
                Some("github") => format!("https://github.com/{}.git", text(&v, "repo")?),
                Some(other) => return Some(Err(format!("{name} comes from a \"{other}\" source, which LemonLime doesn't install."))),
                None => return None,
            };
            (url, text(&v, "path"), text(&v, "ref"), text(&v, "sha"))
        }
        _ => return None,
    };
    let checked = (|| {
        valid_git_url(&url)?;
        if git_ref.as_deref().is_some_and(|r| !valid_ref(r)) {
            return Err(format!("{name} names a branch or tag that isn't valid."));
        }
        if sha.as_deref().is_some_and(|s| s.len() != 40 || !s.chars().all(|c| c.is_ascii_hexdigit())) {
            return Err(format!("{name} pins a commit that isn't a full commit id."));
        }
        if path.as_deref().is_some_and(|p| !safe_relative(p.trim_start_matches("./"))) {
            return Err(format!("{name}'s folder is outside its repository."));
        }
        Ok(())
    })();
    Some(checked.map(|()| Remote { name: name.to_string(), url, path: path.map(|p| p.trim_start_matches("./").to_string()), git_ref, sha, entry: entry.clone() }))
}

/// The plugins a source folder holds: itself, or those its marketplace.json lists from its
/// own folders. With `only`, just that plugin, which may also come from another repository.
/// Plugins a marketplace lists from elsewhere are otherwise returned as skipped.
/// What a source holds: plugins to install, reasons others were skipped, and the plugin
/// picked by name when it lives in another repository.
type Found = (Vec<Candidate>, Vec<String>, Option<Remote>);

fn find_plugins(root: &Path, only: Option<&str>) -> Result<Found, String> {
    if root.join(".claude-plugin").join("plugin.json").is_file() {
        return Ok((vec![Candidate { name: String::new(), folder: root.to_path_buf(), subpath: None, entry: None }], Vec::new(), None));
    }
    let market_path = root.join(".claude-plugin").join("marketplace.json");
    if !market_path.is_file() {
        return Err("There's no .claude-plugin/plugin.json or marketplace.json here, so this isn't a plugin.".into());
    }
    let market = read_json(&market_path, "marketplace.json")?;
    let plugins = market.get("plugins").and_then(Value::as_array).ok_or("marketplace.json lists no plugins.")?;
    if only.is_none() && plugins.len() > MAX_MARKETPLACE_PLUGINS {
        return Err(format!("This marketplace lists {} plugins, too many to install at once. Type the name of the one you want.", plugins.len()));
    }
    let base = market.pointer("/metadata/pluginRoot").and_then(Value::as_str).unwrap_or("").trim_end_matches('/').to_string();
    let mut found = Vec::new();
    let mut skipped = Vec::new();
    let mut remote = None;
    for p in plugins {
        let Some(entry) = p.as_object() else { continue };
        let name = entry.get("name").and_then(Value::as_str).unwrap_or("").to_string();
        if only.is_some_and(|o| o != name) {
            continue;
        }
        if !valid_name(&name) {
            skipped.push(format!("\"{name}\" isn't a valid plugin name."));
            continue;
        }
        if let Some(r) = remote_source(&name, entry) {
            match r {
                Ok(r) if only.is_some() => remote = Some(r),
                Ok(_) => skipped.push(format!("{name} comes from another repository; type its name to install it on its own.")),
                Err(e) => skipped.push(e),
            }
            continue;
        }
        let Some(source) = entry.get("source").and_then(Value::as_str) else {
            skipped.push(format!("{name} has a source LemonLime doesn't understand."));
            continue;
        };
        if source.contains('@') && source.contains(':') {
            skipped.push(format!("{name} comes from another repository."));
            continue;
        }
        let rel = if source.starts_with("./") || source == "." || base.is_empty() { source.to_string() } else { format!("{base}/{source}") };
        let rel = rel.trim_start_matches("./").to_string();
        let rel = if rel.is_empty() || rel == "." { ".".to_string() } else { rel };
        if rel != "." && !safe_relative(&rel) {
            skipped.push(format!("{name}'s folder is outside the repository."));
            continue;
        }
        let folder = if rel == "." { root.to_path_buf() } else { root.join(&rel) };
        if !folder.is_dir() {
            skipped.push(format!("{name}'s folder {rel} is missing."));
            continue;
        }
        found.push(Candidate { name, folder, subpath: Some(rel), entry: Some(entry.clone()) });
    }
    if let Some(o) = only {
        if found.is_empty() && remote.is_none() && skipped.is_empty() {
            return Err(format!("This marketplace doesn't list a plugin called {o}."));
        }
    }
    Ok((found, skipped, remote))
}

/// Stage one candidate as a checked plugin folder inside `scratch`. Returns the staged path
/// and its manifest.
fn stage(scratch: &Path, c: &Candidate) -> Result<(PathBuf, Manifest), String> {
    check_tree(&c.folder)?;
    let staged = scratch.join(format!("stage-{}", rand::thread_rng().gen::<u32>()));
    copy_plugin(&c.folder, &staged, true)?;
    let manifest = staged.join(".claude-plugin").join("plugin.json");
    if !manifest.is_file() {
        // A marketplace entry can stand in for plugin.json.
        let Some(entry) = &c.entry else { return Err("There's no .claude-plugin/plugin.json, so this isn't a plugin.".into()) };
        let mut m = entry.clone();
        for key in ["source", "strict", "category", "tags"] {
            m.remove(key);
        }
        fs::create_dir_all(manifest.parent().unwrap()).map_err(|e| e.to_string())?;
        fs::write(&manifest, serde_json::to_string_pretty(&Value::Object(m)).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    }
    // A marketplace may list a plugin under another name than its plugin.json gives
    // (common for plugins kept in other repositories); it installs under its own name.
    let (m, _, _) = inspect(&staged)?;
    Ok((staged, m))
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct InstallResult {
    installed: Vec<PluginSummary>,
    /// Plugins in a marketplace that weren't installed, and why.
    skipped: Vec<String>,
}

/// Install every plugin `source_root` holds into `dir`. One plugin is turned on straight away;
/// several from a marketplace are installed off, for the user to pick from.
fn install_from(dir: &Path, source_root: &Path, source: &str, git_ref: Option<String>, commit: Option<String>) -> Result<InstallResult, String> {
    let (candidates, skipped, _) = find_plugins(source_root, None)?;
    install_candidates(dir, &candidates, skipped, source, git_ref, commit)
}

fn install_candidates(dir: &Path, candidates: &[Candidate], mut skipped: Vec<String>, source: &str, git_ref: Option<String>, commit: Option<String>) -> Result<InstallResult, String> {
    let scratch = Scratch::new(dir)?;
    let single = candidates.len() == 1 && skipped.is_empty();
    let _guard = lock();
    let mut reg = read_registry(dir)?;
    let mut installed = Vec::new();
    let mut errors = Vec::new();
    for c in candidates {
        let result = stage(&scratch.0, c).and_then(|(staged, m)| {
            if reg.plugins.iter().any(|p| p.name == m.name) || dir.join(&m.name).exists() {
                return Err(format!("You already have a plugin called {}. Update or remove it first.", m.name));
            }
            fs::rename(&staged, dir.join(&m.name)).map_err(|e| format!("Couldn't move {} into place: {e}", m.name))?;
            let now = now_iso();
            let rec = PluginRecord {
                name: m.name.clone(),
                source: source.to_string(),
                version: m.version.clone(),
                enabled: single,
                installed_at: now.clone(),
                updated_at: now,
                commit: commit.clone(),
                git_ref: git_ref.clone(),
                path: c.subpath.clone().filter(|p| p != "."),
            };
            reg.plugins.push(rec.clone());
            Ok(rec)
        });
        match result {
            Ok(rec) => installed.push(rec),
            Err(e) if single => return Err(e),
            Err(e) => errors.push(if c.name.is_empty() { e } else { format!("{}: {e}", c.name) }),
        }
    }
    if installed.is_empty() {
        let all: Vec<String> = errors.into_iter().chain(skipped).collect();
        return Err(if all.is_empty() { "There were no plugins to install.".into() } else { format!("No plugins were installed. {}", all.join(" ")) });
    }
    write_registry(dir, &reg)?;
    skipped.extend(errors);
    Ok(InstallResult { installed: installed.iter().map(|r| summarize(dir, r).0).collect(), skipped })
}

pub fn install_folder_into(dir: &Path, folder: &Path) -> Result<InstallResult, String> {
    let folder = fs::canonicalize(folder).map_err(|e| format!("Couldn't open {}: {e}", folder.display()))?;
    if !folder.is_dir() {
        return Err(format!("{} isn't a folder.", folder.display()));
    }
    if folder.starts_with(dir) {
        return Err("That folder is already inside your plugins folder.".into());
    }
    install_from(dir, &folder, &folder.to_string_lossy(), None, None)
}

/// Run git with no prompts in the terminal, giving up after GIT_TIMEOUT.
fn git(args: &[&str], cwd: Option<&Path>) -> Result<String, String> {
    let program = paths::find_program("git").ok_or("Couldn't find git. Install it, then try again.")?;
    let mut cmd = Command::new(program);
    // Only https: no file://, ssh or ext:: transports, even through redirects or submodules.
    cmd.args(["-c", "protocol.allow=never", "-c", "protocol.https.allow=always"])
        .args(args)
        .env("PATH", paths::search_path())
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let mut child = cmd.spawn().map_err(|e| format!("Couldn't run git: {e}"))?;
    let mut stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let out = thread::spawn(move || {
        let mut s = String::new();
        let _ = stdout.read_to_string(&mut s);
        s
    });
    let err = thread::spawn(move || {
        let mut s = String::new();
        let _ = stderr.read_to_string(&mut s);
        s
    });
    let deadline = Instant::now() + GIT_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("git took too long, so it was stopped.".into());
            }
            Ok(None) => thread::sleep(Duration::from_millis(100)),
            Err(e) => return Err(format!("git failed: {e}")),
        }
    };
    let stdout = out.join().unwrap_or_default();
    let stderr = err.join().unwrap_or_default();
    if status.success() {
        Ok(stdout)
    } else {
        let msg = stderr.lines().rfind(|l| !l.trim().is_empty()).unwrap_or("").trim().to_string();
        Err(if msg.is_empty() { format!("git failed ({status}).") } else { format!("git: {msg}") })
    }
}

/// Shallow-clone `url` (at `git_ref`) into `into` and return the commit checked out.
fn clone(url: &str, git_ref: Option<&str>, into: &Path) -> Result<String, String> {
    valid_git_url(url)?;
    let target = into.to_string_lossy().to_string();
    let mut args = vec!["clone", "--depth", "1", "--single-branch", "--no-tags", "--quiet"];
    if let Some(r) = git_ref {
        if !valid_ref(r) {
            return Err("That branch or tag name isn't valid.".into());
        }
        args.extend(["--branch", r]);
    }
    args.extend(["--", url, &target]);
    git(&args, None)?;
    Ok(git(&["rev-parse", "HEAD"], Some(into))?.trim().to_string())
}

/// Move a fresh shallow clone to the commit a marketplace pins, if it isn't there already.
fn pin(checkout: &Path, sha: &str, head: String) -> Result<String, String> {
    if head.eq_ignore_ascii_case(sha) {
        return Ok(head);
    }
    git(&["fetch", "--quiet", "--depth", "1", "origin", sha], Some(checkout))?;
    git(&["checkout", "--quiet", "--detach", "FETCH_HEAD"], Some(checkout))?;
    Ok(git(&["rev-parse", "HEAD"], Some(checkout))?.trim().to_string())
}

/// Install from a git repository: the plugin it is, every plugin its marketplace lists from
/// its own folders, or with `only` just the named one (which may live in another repository).
pub fn install_git_into(dir: &Path, url: &str, git_ref: Option<String>, only: Option<String>) -> Result<InstallResult, String> {
    let url = url.trim();
    valid_git_url(url)?;
    let git_ref = git_ref.map(|r| r.trim().to_string()).filter(|r| !r.is_empty());
    if git_ref.as_deref().is_some_and(|r| !valid_ref(r)) {
        return Err("That branch or tag name isn't valid.".into());
    }
    let only = only.map(|o| o.trim().to_string()).filter(|o| !o.is_empty());
    let scratch = Scratch::new(dir)?;
    let checkout = scratch.0.join("clone");
    let commit = clone(url, git_ref.as_deref(), &checkout)?;
    let Some(name) = only else {
        return install_from(dir, &checkout, url, git_ref, Some(commit));
    };
    let (found, skipped, remote) = find_plugins(&checkout, Some(&name))?;
    if !found.is_empty() {
        return install_candidates(dir, &found, skipped, url, git_ref, Some(commit));
    }
    let Some(r) = remote else {
        return Err(skipped.join(" "));
    };
    let elsewhere = scratch.0.join("remote");
    let head = clone(&r.url, r.git_ref.as_deref(), &elsewhere)?;
    let head = match &r.sha {
        Some(sha) => pin(&elsewhere, sha, head)?,
        None => head,
    };
    let folder = match &r.path {
        Some(p) => elsewhere.join(p),
        None => elsewhere.clone(),
    };
    if !folder.is_dir() {
        return Err(format!("{}'s folder isn't in {}.", r.name, r.url));
    }
    let c = Candidate { name: r.name.clone(), folder, subpath: r.path.clone(), entry: Some(r.entry) };
    install_candidates(dir, &[c], Vec::new(), &r.url, r.git_ref, Some(head))
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UpdateResult {
    name: String,
    previous_version: Option<String>,
    version: Option<String>,
    previous_commit: Option<String>,
    commit: Option<String>,
    /// False when the plugin was already up to date.
    changed: bool,
}

/// Fetch the plugin's source again and swap the new copy in if it checks out.
pub fn update_in(dir: &Path, name: &str) -> Result<UpdateResult, String> {
    let rec = read_registry(dir)?.plugins.into_iter().find(|p| p.name == name).ok_or(format!("There's no plugin called {name}."))?;
    let scratch = Scratch::new(dir)?;
    let (root, commit) = if source_kind(&rec.source) == "git" {
        let checkout = scratch.0.join("clone");
        let commit = clone(&rec.source, rec.git_ref.as_deref(), &checkout)?;
        if rec.commit.as_deref() == Some(commit.as_str()) {
            return Ok(UpdateResult {
                name: rec.name,
                previous_version: rec.version.clone(),
                version: rec.version,
                previous_commit: rec.commit.clone(),
                commit: rec.commit,
                changed: false,
            });
        }
        (checkout, Some(commit))
    } else {
        let folder = PathBuf::from(&rec.source);
        if !folder.is_dir() {
            return Err(format!("The folder it came from, {}, is gone.", folder.display()));
        }
        (folder, None)
    };
    let in_folder = rec.path.as_deref().map(|p| root.join(p)).filter(|f| f.is_dir() && !f.join(".claude-plugin").join("marketplace.json").is_file());
    let c = match in_folder {
        // A plugin from inside a repository (a marketplace's folder, or another repository's
        // subfolder): its folder, with the manifest it was installed with if it has none.
        Some(folder) if folder.join(".claude-plugin").join("plugin.json").is_file() || !root.join(".claude-plugin").join("marketplace.json").is_file() => {
            let installed = read_json(&dir.join(&rec.name).join(".claude-plugin").join("plugin.json"), "plugin.json").ok();
            Candidate { name: rec.name.clone(), folder, subpath: rec.path.clone(), entry: installed.and_then(|v| v.as_object().cloned()) }
        }
        _ => {
            let (candidates, _, _) = find_plugins(&root, None)?;
            candidates
                .into_iter()
                .find(|c| c.subpath.as_deref().filter(|p| *p != ".") == rec.path.as_deref() || c.name == rec.name)
                .ok_or("The plugin is no longer in its source.")?
        }
    };
    let (staged, m) = stage(&scratch.0, &c)?;
    if m.name != rec.name {
        return Err(format!("Its plugin.json now calls it {}; remove it and install it again.", m.name));
    }
    let _guard = lock();
    let target = dir.join(&rec.name);
    let old = scratch.0.join("previous");
    if target.exists() {
        fs::rename(&target, &old).map_err(|e| format!("Couldn't replace the old copy: {e}"))?;
    }
    if let Err(e) = fs::rename(&staged, &target) {
        let _ = fs::rename(&old, &target);
        return Err(format!("Couldn't move the new copy into place: {e}"));
    }
    let mut reg = read_registry(dir)?;
    let entry = reg.plugins.iter_mut().find(|p| p.name == rec.name).ok_or("The plugin was removed meanwhile.")?;
    entry.version = m.version.clone();
    entry.commit = commit.clone();
    entry.updated_at = now_iso();
    write_registry(dir, &reg)?;
    Ok(UpdateResult {
        name: rec.name,
        changed: rec.commit != commit || rec.version != m.version || commit.is_none(),
        previous_version: rec.version,
        version: m.version,
        previous_commit: rec.commit,
        commit,
    })
}

pub fn set_enabled_in(dir: &Path, name: &str, enabled: bool) -> Result<(), String> {
    let _guard = lock();
    let mut reg = read_registry(dir)?;
    let rec = reg.plugins.iter_mut().find(|p| p.name == name).ok_or(format!("There's no plugin called {name}."))?;
    rec.enabled = enabled;
    rec.updated_at = now_iso();
    write_registry(dir, &reg)
}

pub fn remove_in(dir: &Path, name: &str) -> Result<(), String> {
    if !valid_name(name) {
        return Err("Not a plugin name.".into());
    }
    let _guard = lock();
    let mut reg = read_registry(dir)?;
    let before = reg.plugins.len();
    reg.plugins.retain(|p| p.name != name);
    let folder = dir.join(name);
    if before == reg.plugins.len() && !folder.exists() {
        return Err(format!("There's no plugin called {name}."));
    }
    write_registry(dir, &reg)?;
    if folder.exists() {
        fs::remove_dir_all(&folder).map_err(|e| format!("Couldn't remove its folder: {e}"))?;
    }
    Ok(())
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheck {
    name: String,
    /// The newest commit on the plugin's branch, if it could be asked.
    latest_commit: Option<String>,
    has_update: bool,
    error: Option<String>,
}

/// Ask each git plugin's repository for its newest commit (no download).
pub fn check_updates_in(dir: &Path) -> Result<Vec<UpdateCheck>, String> {
    let reg = read_registry(dir)?;
    let checks = reg
        .plugins
        .into_iter()
        .filter(|p| source_kind(&p.source) == "git" && valid_git_url(&p.source).is_ok())
        .map(|p| {
            thread::spawn(move || {
                let wanted = p.git_ref.clone().unwrap_or_else(|| "HEAD".into());
                let result = if valid_ref(&wanted) || wanted == "HEAD" { git(&["ls-remote", "--", &p.source, &wanted], None) } else { Err("bad ref".into()) };
                match result {
                    Ok(out) => {
                        let latest = out.lines().next().and_then(|l| l.split_whitespace().next()).map(str::to_string);
                        UpdateCheck { has_update: latest.is_some() && latest != p.commit, latest_commit: latest, name: p.name, error: None }
                    }
                    Err(e) => UpdateCheck { name: p.name, latest_commit: None, has_update: false, error: Some(e) },
                }
            })
        })
        .collect::<Vec<_>>();
    Ok(checks.into_iter().filter_map(|h| h.join().ok()).collect())
}

// ---------------------------------------------------------------------------------------
// Commands

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| format!("Something went wrong: {e}"))?
}

#[tauri::command]
pub async fn list_plugins() -> Result<Vec<PluginSummary>, String> {
    blocking(|| list_in(&require_dir()?)).await
}

#[tauri::command]
pub async fn read_plugin(name: String) -> Result<PluginDetail, String> {
    blocking(move || read_in(&require_dir()?, &name)).await
}

#[tauri::command]
pub async fn install_plugin_from_git(url: String, git_ref: Option<String>, plugin: Option<String>) -> Result<InstallResult, String> {
    blocking(move || install_git_into(&require_dir()?, &url, git_ref, plugin)).await
}

#[tauri::command]
pub async fn install_plugin_from_folder(path: String) -> Result<InstallResult, String> {
    blocking(move || install_folder_into(&require_dir()?, Path::new(&path))).await
}

#[tauri::command]
pub async fn set_plugin_enabled(name: String, enabled: bool) -> Result<(), String> {
    blocking(move || set_enabled_in(&require_dir()?, &name, enabled)).await
}

#[tauri::command]
pub async fn update_plugin(name: String) -> Result<UpdateResult, String> {
    blocking(move || update_in(&require_dir()?, &name)).await
}

#[tauri::command]
pub async fn remove_plugin(name: String) -> Result<(), String> {
    blocking(move || remove_in(&require_dir()?, &name)).await
}

#[tauri::command]
pub async fn check_plugin_updates() -> Result<Vec<UpdateCheck>, String> {
    blocking(|| check_updates_in(&require_dir()?)).await
}

/// Where plugins live, created if missing (for "Show in folder").
#[tauri::command]
pub fn plugins_folder() -> Result<String, String> {
    Ok(require_dir()?.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDir(PathBuf);
    impl TempDir {
        fn new(tag: &str) -> Self {
            let id: u64 = rand::thread_rng().gen();
            let p = std::env::temp_dir().join(format!("lemonlime-plugins-{tag}-{id:x}"));
            fs::create_dir_all(&p).unwrap();
            TempDir(fs::canonicalize(&p).unwrap())
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn write(path: &Path, text: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    fn make_plugin(dir: &Path, name: &str) {
        write(&dir.join(".claude-plugin/plugin.json"), &format!(r#"{{"name":"{name}","description":"Helps","version":"1.0.0","author":{{"name":"Sam"}}}}"#));
        write(&dir.join("skills/tidy/SKILL.md"), "---\nname: tidy\ndescription: Tidy up. Use always.\n---\n");
        write(&dir.join("commands/review.md"), "Review.\n");
        write(&dir.join("commands/git/summary.md"), "Summary.\n");
        write(&dir.join("agents/reviewer.md"), "---\nname: reviewer\n---\n");
        write(&dir.join(".mcp.json"), r#"{"mcpServers":{"notes":{"command":"notes"},"docs":{"type":"http","url":"https://example.com/mcp"}}}"#);
        write(&dir.join("hooks/hooks.json"), r#"{"hooks":{"PreToolUse":[],"Stop":[]}}"#);
        write(&dir.join("README.md"), "# Hello\n");
    }

    #[test]
    fn names_paths_urls_and_refs() {
        assert!(valid_name("review-kit"));
        assert!(valid_name("kit_2.0"));
        assert!(!valid_name("../x"));
        assert!(!valid_name(".hidden"));
        assert!(!valid_name("a/b"));
        assert!(!valid_name("a..b"));
        assert!(!valid_name(""));
        assert!(safe_relative("commands/x.md"));
        assert!(!safe_relative("../x"));
        assert!(!safe_relative("a/../../x"));
        assert!(!safe_relative("/etc"));
        assert!(!safe_relative("C:/x"));
        assert!(!safe_relative("a\\..\\b"));
        assert!(valid_git_url("https://github.com/acme/plugins.git").is_ok());
        assert!(valid_git_url("http://github.com/acme/plugins").is_err());
        assert!(valid_git_url("git@github.com:acme/plugins.git").is_err());
        assert!(valid_git_url("file:///etc").is_err());
        assert!(valid_git_url("https://user:token@github.com/acme/x").is_err());
        assert!(valid_git_url("https://github.com/").is_err());
        assert!(valid_git_url("https://github.com/a b").is_err());
        assert!(valid_ref("main"));
        assert!(valid_ref("release/v1.2"));
        assert!(!valid_ref("-x"));
        assert!(!valid_ref("--upload-pack=evil"));
        assert!(!valid_ref("a..b"));
        assert_eq!(iso_from_unix(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso_from_unix(1_709_210_096), "2024-02-29T12:34:56Z");
    }

    #[test]
    fn manifests() {
        assert!(parse_manifest(serde_json::json!({"name": "ok"})).is_ok());
        assert!(parse_manifest(serde_json::json!({})).is_err());
        assert!(parse_manifest(serde_json::json!({"name": "../x"})).is_err());
        assert!(parse_manifest(serde_json::json!({"name": "ok", "version": 3})).is_err());
        assert!(parse_manifest(serde_json::json!({"name": "ok", "commands": "../out"})).is_err());
        assert!(parse_manifest(serde_json::json!({"name": "ok", "agents": ["./a.md", "/abs"]})).is_err());
        assert!(parse_manifest(serde_json::json!({"name": "ok", "hooks": "../../h.json"})).is_err());
        assert_eq!(parse_manifest(serde_json::json!({"name": "ok", "author": "Sam"})).unwrap().author.as_deref(), Some("Sam"));
    }

    #[test]
    fn reads_what_a_plugin_gives() {
        let t = TempDir::new("inspect");
        make_plugin(&t.0, "kit");
        let (m, c, readme) = inspect(&t.0).unwrap();
        assert_eq!(m.name, "kit");
        assert_eq!(m.author.as_deref(), Some("Sam"));
        assert_eq!(c.skills, vec!["tidy"]);
        assert_eq!(c.commands, vec!["git/summary", "review"]);
        assert_eq!(c.agents, vec!["reviewer"]);
        assert_eq!(c.mcp_servers, vec!["docs", "notes"]);
        assert_eq!(c.hooks, vec!["PreToolUse", "Stop"]);
        assert!(!c.hooks_applied);
        assert_eq!(readme.as_deref(), Some("# Hello\n"));
    }

    #[test]
    fn refuses_unsafe_plugins() {
        let t = TempDir::new("unsafe");
        make_plugin(&t.0, "kit");
        write(&t.0.join(".mcp.json"), r#"{"mcpServers":{"bad name":{"command":"x"}}}"#);
        assert!(inspect(&t.0).unwrap_err().contains("MCP server name"));
        write(&t.0.join(".mcp.json"), r#"{"mcpServers":{"x":{"args":[]}}}"#);
        assert!(inspect(&t.0).unwrap_err().contains("needs a command"));
        fs::remove_file(t.0.join(".mcp.json")).unwrap();
        fs::write(t.0.join("big.bin"), vec![0u8; (MAX_FILE_BYTES + 1) as usize]).unwrap();
        assert!(inspect(&t.0).unwrap_err().contains("over 5 MB"));
        fs::remove_file(t.0.join("big.bin")).unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink("/etc/hosts", t.0.join("hosts")).unwrap();
            assert!(inspect(&t.0).unwrap_err().contains("link"));
            fs::remove_file(t.0.join("hosts")).unwrap();
        }
        assert!(inspect(&t.0).is_ok());
        let empty = TempDir::new("empty");
        assert!(inspect(&empty.0).unwrap_err().contains("plugin.json"));
    }

    #[test]
    fn installs_enables_updates_and_removes_a_folder_plugin() {
        let home = TempDir::new("home");
        let src = TempDir::new("src");
        make_plugin(&src.0, "kit");
        let result = install_folder_into(&home.0, &src.0).unwrap();
        assert_eq!(result.installed.len(), 1);
        assert!(result.installed[0].enabled);
        assert!(home.0.join("kit/.claude-plugin/plugin.json").is_file());
        assert!(!home.0.join(TMP_DIR).read_dir().map(|mut d| d.next().is_some()).unwrap_or(false));

        // The runner reads this file; keep its shape.
        let reg: Value = serde_json::from_str(&fs::read_to_string(home.0.join(REGISTRY_FILE)).unwrap()).unwrap();
        let rec = &reg["plugins"][0];
        assert_eq!(rec["name"], "kit");
        assert_eq!(rec["version"], "1.0.0");
        assert_eq!(rec["enabled"], true);
        assert!(rec["installedAt"].as_str().unwrap().ends_with('Z'));
        assert!(rec.get("commit").is_some());

        assert!(install_folder_into(&home.0, &src.0).unwrap_err().contains("already have"));
        set_enabled_in(&home.0, "kit", false).unwrap();
        assert!(!list_in(&home.0).unwrap()[0].enabled);

        write(&src.0.join(".claude-plugin/plugin.json"), r#"{"name":"kit","version":"1.1.0"}"#);
        write(&src.0.join("commands/new.md"), "New.\n");
        let up = update_in(&home.0, "kit").unwrap();
        assert_eq!(up.previous_version.as_deref(), Some("1.0.0"));
        assert_eq!(up.version.as_deref(), Some("1.1.0"));
        let detail = read_in(&home.0, "kit").unwrap();
        assert!(detail.summary.contents.commands.contains(&"new".to_string()));
        assert!(!detail.summary.enabled, "an update keeps the plugin off");

        remove_in(&home.0, "kit").unwrap();
        assert!(!home.0.join("kit").exists());
        assert!(list_in(&home.0).unwrap().is_empty());
    }

    /// Needs the network: `LEMONLIME_PLUGIN_TEST_URL=https://... cargo test -- --ignored`.
    #[test]
    #[ignore]
    fn installs_from_a_real_repository() {
        let Ok(url) = std::env::var("LEMONLIME_PLUGIN_TEST_URL") else { return };
        let home = TempDir::new("git");
        let only = std::env::var("LEMONLIME_PLUGIN_TEST_NAME").ok();
        let result = install_git_into(&home.0, &url, None, only).unwrap();
        assert!(!result.installed.is_empty());
        assert!(result.installed[0].commit.as_deref().is_some_and(|c| c.len() == 40));
        let checks = check_updates_in(&home.0).unwrap();
        assert!(checks.iter().all(|c| c.error.is_none()), "{checks:?}");
        // Updating fetches it again from wherever it came from.
        let name = result.installed[0].name.clone();
        update_in(&home.0, &name).unwrap();
        assert!(read_in(&home.0, &name).is_ok());
    }

    #[test]
    fn installs_the_local_plugins_of_a_marketplace() {
        let home = TempDir::new("mhome");
        let src = TempDir::new("market");
        make_plugin(&src.0.join("plugins/one"), "one");
        write(&src.0.join("plugins/two/commands/hello.md"), "Hello.\n");
        write(
            &src.0.join(".claude-plugin/marketplace.json"),
            r#"{"name":"team","plugins":[
                {"name":"one","source":"./plugins/one"},
                {"name":"two","source":"./plugins/two","description":"No manifest of its own","version":"0.1.0"},
                {"name":"three","source":{"source":"github","repo":"someone/three"}},
                {"name":"four","source":"../outside"},
                {"name":"five","source":"https://example.com/five.git"}
            ]}"#,
        );
        let result = install_folder_into(&home.0, &src.0).unwrap();
        let names: Vec<_> = result.installed.iter().map(|p| p.name.clone()).collect();
        assert_eq!(names, vec!["one", "two"]);
        assert!(result.installed.iter().all(|p| !p.enabled), "a marketplace's plugins start off");
        assert_eq!(result.skipped.len(), 3);
        let two = read_in(&home.0, "two").unwrap();
        assert_eq!(two.summary.description, "No manifest of its own");
        assert_eq!(two.summary.contents.commands, vec!["hello"]);
        // Updating finds it again inside the marketplace.
        write(&src.0.join("plugins/two/commands/bye.md"), "Bye.\n");
        update_in(&home.0, "two").unwrap();
        assert_eq!(read_in(&home.0, "two").unwrap().summary.contents.commands, vec!["bye", "hello"]);
    }

    #[test]
    fn picks_one_plugin_by_name_including_ones_kept_elsewhere() {
        let src = TempDir::new("pick");
        make_plugin(&src.0.join("plugins/one"), "one");
        let mut entries = vec![
            r#"{"name":"one","source":"./plugins/one"}"#.to_string(),
            r#"{"name":"sub","source":{"source":"git-subdir","url":"https://github.com/a/b.git","path":"plugins/sub","ref":"v1","sha":"0123456789abcdef0123456789abcdef01234567"}}"#.to_string(),
            r#"{"name":"whole","source":{"source":"url","url":"https://github.com/a/whole.git"}}"#.to_string(),
            r#"{"name":"gh","source":{"source":"github","repo":"a/gh"}}"#.to_string(),
            r#"{"name":"cmd","source":{"source":"command","command":"rm -rf /"}}"#.to_string(),
            r#"{"name":"bad","source":{"source":"url","url":"http://insecure.example/x.git"}}"#.to_string(),
            r#"{"name":"escape","source":{"source":"git-subdir","url":"https://github.com/a/b.git","path":"../up"}}"#.to_string(),
        ];
        // A big marketplace: too many to install at once, fine to pick from.
        for i in 0..120 {
            entries.push(format!(r#"{{"name":"extra{i}","source":"./plugins/extra{i}"}}"#));
        }
        write(&src.0.join(".claude-plugin/marketplace.json"), &format!(r#"{{"name":"big","plugins":[{}]}}"#, entries.join(",")));

        let all = find_plugins(&src.0, None).err().unwrap();
        assert!(all.contains("127 plugins"), "{all}");

        let (found, _, remote) = find_plugins(&src.0, Some("one")).unwrap();
        assert_eq!(found.len(), 1);
        assert!(remote.is_none());

        let (found, _, remote) = find_plugins(&src.0, Some("sub")).unwrap();
        assert!(found.is_empty());
        let r = remote.unwrap();
        assert_eq!((r.url.as_str(), r.path.as_deref(), r.git_ref.as_deref()), ("https://github.com/a/b.git", Some("plugins/sub"), Some("v1")));
        assert_eq!(r.sha.as_deref(), Some("0123456789abcdef0123456789abcdef01234567"));

        assert_eq!(find_plugins(&src.0, Some("whole")).unwrap().2.unwrap().path, None);
        assert_eq!(find_plugins(&src.0, Some("gh")).unwrap().2.unwrap().url, "https://github.com/a/gh.git");
        for refused in ["cmd", "bad", "escape"] {
            let (found, skipped, remote) = find_plugins(&src.0, Some(refused)).unwrap();
            assert!(found.is_empty() && remote.is_none() && skipped.len() == 1, "{refused} should be refused");
        }
        assert!(find_plugins(&src.0, Some("nope")).err().unwrap().contains("doesn't list"));
    }
}
