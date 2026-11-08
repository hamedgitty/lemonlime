//! Skills: folders with a SKILL.md that agents read. LemonLime's own ship with the app;
//! the user's live in `~/.lemonlime/skills` (or `$LEMONLIME_HOME/skills`), which the
//! runner copies into every local thread next to the bundled ones.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInfo {
    name: String,
    description: String,
    /// "bundled" or "yours".
    source: &'static str,
}

/// Skills bigger than this are refused: they are copied into every thread.
const MAX_SKILL_BYTES: u64 = 20 * 1024 * 1024;

pub fn user_skills_dir() -> Option<PathBuf> {
    if let Some(home) = std::env::var_os("LEMONLIME_HOME").filter(|v| !v.is_empty()) {
        return Some(PathBuf::from(home).join("skills"));
    }
    #[cfg(windows)]
    let home = std::env::var_os("USERPROFILE");
    #[cfg(not(windows))]
    let home = std::env::var_os("HOME");
    home.filter(|h| !h.is_empty()).map(|h| PathBuf::from(h).join(".lemonlime").join("skills"))
}

/// A skill's folder name: letters, digits, dot, dash and underscore, not starting with a dot.
fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && !name.starts_with('.')
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
}

/// The `description:` line of SKILL.md's front matter, if any.
fn description_of(skill_md: &Path) -> String {
    let Ok(text) = fs::read_to_string(skill_md) else { return String::new() };
    let mut lines = text.lines();
    if lines.next().map(str::trim) != Some("---") {
        return String::new();
    }
    for line in lines {
        let line = line.trim();
        if line == "---" {
            break;
        }
        if let Some(rest) = line.strip_prefix("description:") {
            return rest.trim().trim_matches(|c| c == '"' || c == '\'').to_string();
        }
    }
    String::new()
}

fn list_in(dir: &Path, source: &'static str) -> Vec<SkillInfo> {
    let Ok(entries) = fs::read_dir(dir) else { return Vec::new() };
    let mut out: Vec<SkillInfo> = entries
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            let path = e.path();
            let md = path.join("SKILL.md");
            (valid_name(&name) && path.is_dir() && md.is_file()).then(|| SkillInfo { name, description: description_of(&md), source })
        })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

fn bundled_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().resolve("skills", tauri::path::BaseDirectory::Resource).ok().filter(|p| p.is_dir())
}

fn home_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    let home = std::env::var_os("USERPROFILE");
    #[cfg(not(windows))]
    let home = std::env::var_os("HOME");
    home.filter(|h| !h.is_empty()).map(PathBuf::from)
}

/// Skills the agents keep for themselves on this computer (read-only here; they already
/// reach that agent wherever it runs on this computer).
fn agent_skill_dirs() -> Vec<(PathBuf, &'static str)> {
    let Some(home) = home_dir() else { return Vec::new() };
    vec![
        (home.join(".claude").join("skills"), "claude-code"),
        (home.join(".codex").join("skills"), "codex"),
        (home.join(".agents").join("skills"), "shared"),
        (home.join(".config").join("opencode").join("skill"), "opencode"),
    ]
}

#[tauri::command]
pub fn list_skills(app: AppHandle) -> Vec<SkillInfo> {
    let mut out = bundled_dir(&app).map(|d| list_in(&d, "bundled")).unwrap_or_default();
    if let Some(dir) = user_skills_dir() {
        out.extend(list_in(&dir, "yours"));
    }
    for (dir, source) in agent_skill_dirs() {
        out.extend(list_in(&dir, source));
    }
    out
}

fn skill_dir(app: &AppHandle, name: &str, source: &str) -> Result<PathBuf, String> {
    if !valid_name(name) {
        return Err("Not a skill name.".into());
    }
    let base = match source {
        "bundled" => bundled_dir(app),
        "yours" => user_skills_dir(),
        other => agent_skill_dirs().into_iter().find(|(_, s)| *s == other).map(|(d, _)| d),
    }
    .ok_or("Couldn't find that skill.")?;
    let dir = base.join(name);
    let meta = fs::symlink_metadata(&dir).map_err(|_| format!("There's no skill called {name}."))?;
    if !meta.is_dir() || !dir.join("SKILL.md").is_file() {
        return Err(format!("There's no skill called {name}."));
    }
    Ok(dir)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillDetail {
    name: String,
    path: String,
    /// SKILL.md as written (front matter included), cut at 512 KB.
    content: String,
    /// Other files in the folder, relative, at most 200.
    files: Vec<String>,
}

fn files_in(dir: &Path, prefix: &str, out: &mut Vec<String>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    let mut entries: Vec<_> = entries.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        if out.len() >= 200 {
            return;
        }
        let name = e.file_name().to_string_lossy().to_string();
        let rel = if prefix.is_empty() { name.clone() } else { format!("{prefix}/{name}") };
        match e.file_type() {
            Ok(t) if t.is_dir() => files_in(&e.path(), &rel, out),
            Ok(t) if t.is_file() && rel != "SKILL.md" => out.push(rel),
            _ => {}
        }
    }
}

/// A skill's SKILL.md and what else is in its folder, for the preview.
#[tauri::command]
pub fn read_skill(app: AppHandle, name: String, source: String) -> Result<SkillDetail, String> {
    let dir = skill_dir(&app, &name, &source)?;
    let bytes = fs::read(dir.join("SKILL.md")).map_err(|e| format!("Couldn't read it: {e}"))?;
    let cut = &bytes[..bytes.len().min(512 * 1024)];
    let mut files = Vec::new();
    files_in(&dir, "", &mut files);
    Ok(SkillDetail { name, path: dir.to_string_lossy().to_string(), content: String::from_utf8_lossy(cut).to_string(), files })
}

/// Copy a bundled or agent skill into the user's skills, so it can be changed and reaches
/// every agent and thread. `as_name` renames the copy.
#[tauri::command]
pub fn fork_skill(app: AppHandle, name: String, source: String, as_name: Option<String>) -> Result<String, String> {
    if source == "yours" {
        return Err("That skill is already yours.".into());
    }
    let from = skill_dir(&app, &name, &source)?;
    let target_name = as_name.filter(|n| !n.trim().is_empty()).unwrap_or(name);
    if !valid_name(&target_name) {
        return Err("Use letters, numbers, dots, dashes or underscores for the name.".into());
    }
    size_of(&from)?;
    let dir = user_skills_dir().ok_or("Couldn't find your home folder.")?;
    let to = dir.join(&target_name);
    if to.exists() {
        return Err(format!("You already have a skill called {target_name}."));
    }
    copy_dir(&from, &to).map_err(|e| {
        let _ = fs::remove_dir_all(&to);
        format!("Couldn't copy the skill: {e}")
    })?;
    Ok(target_name)
}

/// Total size of regular files under `dir`, refusing symlinks (they could point anywhere).
fn size_of(dir: &Path) -> Result<u64, String> {
    let mut total = 0;
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let kind = entry.file_type().map_err(|e| e.to_string())?;
        if kind.is_symlink() {
            return Err(format!("{} is a link; skills can't contain links.", entry.path().display()));
        }
        total += if kind.is_dir() { size_of(&entry.path())? } else { entry.metadata().map_err(|e| e.to_string())?.len() };
        if total > MAX_SKILL_BYTES {
            return Err("That folder is over 20 MB. Skills are copied into every thread, so keep them small.".into());
        }
    }
    Ok(total)
}

fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        let kind = entry.file_type()?;
        if kind.is_symlink() {
            continue;
        } else if kind.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

/// Copy a skill folder (one holding SKILL.md) into the user's skills. Returns its name.
#[tauri::command]
pub fn add_skill(path: String) -> Result<String, String> {
    let from = PathBuf::from(&path);
    if !from.join("SKILL.md").is_file() {
        return Err("That folder has no SKILL.md, so it isn't a skill.".into());
    }
    let name = from.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    if !valid_name(&name) {
        return Err("Rename the folder to letters, numbers, dots, dashes or underscores first.".into());
    }
    size_of(&from)?;
    let dir = user_skills_dir().ok_or("Couldn't find your home folder.")?;
    let to = dir.join(&name);
    if to.exists() {
        return Err(format!("You already have a skill called {name}. Remove it first to replace it."));
    }
    copy_dir(&from, &to).map_err(|e| {
        let _ = fs::remove_dir_all(&to);
        format!("Couldn't copy the skill: {e}")
    })?;
    Ok(name)
}

/// One file of a skill downloaded from a public catalogue, base64-encoded.
#[derive(Deserialize)]
pub struct DownloadedFile {
    /// Relative to the skill's folder, e.g. "SKILL.md" or "scripts/run.py".
    path: String,
    base64: String,
}

/// Save a skill downloaded from a public catalogue into the user's skills, under `name`.
/// The same rules as adding a folder: a SKILL.md, a plain name, under 20 MB, nothing
/// outside its folder. It is written next to the skills first and moved in once complete.
#[tauri::command]
pub fn add_skill_files(name: String, files: Vec<DownloadedFile>) -> Result<String, String> {
    let dir = user_skills_dir().ok_or("Couldn't find your home folder.")?;
    add_files_into(&dir, &name, files)
}

fn add_files_into(dir: &Path, name: &str, files: Vec<DownloadedFile>) -> Result<String, String> {
    if !valid_name(name) {
        return Err("Use letters, numbers, dots, dashes or underscores for the name.".into());
    }
    if !files.iter().any(|f| f.path == "SKILL.md") {
        return Err("That skill has no SKILL.md.".into());
    }
    let to = dir.join(name);
    if to.exists() {
        return Err(format!("You already have a skill called {name}."));
    }
    let mut decoded = Vec::with_capacity(files.len());
    let mut total: u64 = 0;
    for f in files {
        if !crate::plugins::safe_relative(&f.path) || f.path.split('/').any(|s| s.is_empty() || s == ".") {
            return Err(format!("{} would land outside the skill's folder.", f.path));
        }
        let bytes = decode_base64(&f.base64).ok_or_else(|| format!("{} didn't download properly. Try again.", f.path))?;
        total += bytes.len() as u64;
        if total > MAX_SKILL_BYTES {
            return Err("That skill is over 20 MB. Skills are copied into every thread, so keep them small.".into());
        }
        decoded.push((f.path, bytes));
    }
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    // Staged beside the skills folder, so a half-written copy never reaches a thread.
    let parent = dir.parent().unwrap_or(dir);
    let staging = parent.join(format!(".skill-download-{}-{}", name, std::process::id()));
    let _ = fs::remove_dir_all(&staging);
    let written = (|| -> std::io::Result<()> {
        for (path, bytes) in &decoded {
            let target = staging.join(path);
            if let Some(up) = target.parent() {
                fs::create_dir_all(up)?;
            }
            fs::write(target, bytes)?;
        }
        fs::rename(&staging, &to)
    })();
    written.map_err(|e| {
        let _ = fs::remove_dir_all(&staging);
        format!("Couldn't save the skill: {e}")
    })?;
    Ok(name.to_string())
}

/// Standard base64 (with or without padding; line breaks ignored). None if it isn't base64.
fn decode_base64(text: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(text.len() / 4 * 3);
    let (mut acc, mut bits) = (0u32, 0u32);
    for c in text.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' | b'\n' | b'\r' => continue,
            _ => return None,
        };
        acc = (acc << 6) | u32::from(v);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    Some(out)
}

/// Remove one of the user's skills (never a bundled one).
#[tauri::command]
pub fn remove_skill(name: String) -> Result<(), String> {
    if !valid_name(&name) {
        return Err("Not a skill name.".into());
    }
    let dir = user_skills_dir().ok_or("Couldn't find your home folder.")?;
    let target = dir.join(&name);
    if !target.join("SKILL.md").is_file() {
        return Err(format!("There's no skill called {name}."));
    }
    fs::remove_dir_all(&target).map_err(|e| format!("Couldn't remove it: {e}"))
}

/// Where the user's skills live, created if missing (for "Open folder").
#[tauri::command]
pub fn skills_folder() -> Result<String, String> {
    let dir = user_skills_dir().ok_or("Couldn't find your home folder.")?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().to_string())
}

#[derive(Serialize)]
pub struct ExportedSkill {
    name: String,
    /// Relative path → text content.
    files: std::collections::BTreeMap<String, String>,
}

const MAX_EXPORT_BYTES: usize = 1024 * 1024;

fn collect_text(dir: &Path, prefix: &str, out: &mut std::collections::BTreeMap<String, String>, total: &mut usize) -> Result<(), String> {
    let mut entries: Vec<_> = fs::read_dir(dir).map_err(|e| e.to_string())?.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let rel = if prefix.is_empty() { name } else { format!("{prefix}/{name}") };
        let kind = e.file_type().map_err(|e| e.to_string())?;
        if kind.is_dir() {
            collect_text(&e.path(), &rel, out, total)?;
        } else if kind.is_file() {
            let bytes = fs::read(e.path()).map_err(|e| e.to_string())?;
            // Text only: scripts and Markdown. Binary files stay on this computer.
            let Ok(text) = String::from_utf8(bytes) else { continue };
            *total += text.len();
            if *total > MAX_EXPORT_BYTES {
                return Err("Those skills add up to more than 1 MB of text, too much to sync. Pick fewer.".into());
            }
            out.insert(rel, text);
        }
    }
    Ok(())
}

/// The text files of some of the user's skills, to upload for cloud sandboxes.
#[tauri::command]
pub fn export_skills(names: Vec<String>) -> Result<Vec<ExportedSkill>, String> {
    let dir = user_skills_dir().ok_or("Couldn't find your home folder.")?;
    let mut total = 0;
    let mut out = Vec::new();
    for name in names {
        if !valid_name(&name) || !dir.join(&name).join("SKILL.md").is_file() {
            return Err(format!("There's no skill called {name}."));
        }
        let mut files = std::collections::BTreeMap::new();
        collect_text(&dir.join(&name), "", &mut files, &mut total)?;
        out.push(ExportedSkill { name, files });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64() {
        assert_eq!(decode_base64("aGVsbG8=").unwrap(), b"hello");
        assert_eq!(decode_base64("aGVsbG8").unwrap(), b"hello");
        assert_eq!(decode_base64("").unwrap(), b"");
        assert_eq!(decode_base64("AAEC/w==").unwrap(), vec![0, 1, 2, 255]);
        assert!(decode_base64("not base64!").is_none());
    }

    #[test]
    fn saves_a_downloaded_skill() {
        let root = std::env::temp_dir().join(format!("lemonlime-skill-dl-{}", std::process::id()));
        let dir = root.join("skills");
        let file = |path: &str, b64: &str| DownloadedFile { path: path.into(), base64: b64.into() };
        let ok = add_files_into(&dir, "hello", vec![file("SKILL.md", "aGVsbG8="), file("scripts/run.sh", "AAEC")]).unwrap();
        assert_eq!(ok, "hello");
        assert_eq!(fs::read(dir.join("hello/SKILL.md")).unwrap(), b"hello");
        assert_eq!(fs::read(dir.join("hello/scripts/run.sh")).unwrap(), vec![0, 1, 2]);
        assert!(add_files_into(&dir, "hello", vec![file("SKILL.md", "")]).unwrap_err().contains("already"));
        assert!(add_files_into(&dir, "other", vec![file("README.md", "")]).is_err());
        assert!(add_files_into(&dir, "evil", vec![file("SKILL.md", ""), file("../x", "")]).is_err());
        assert!(add_files_into(&dir, "evil", vec![file("SKILL.md", ""), file("/etc/x", "")]).is_err());
        assert!(add_files_into(&dir, "../up", vec![file("SKILL.md", "")]).is_err());
        assert!(!dir.join("evil").exists());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn names_and_descriptions() {
        assert!(valid_name("my-skill_1.2"));
        assert!(!valid_name("../x"));
        assert!(!valid_name(".hidden"));
        assert!(!valid_name("a/b"));
        let dir = std::env::temp_dir().join(format!("lemonlime-skill-test-{}", std::process::id()));
        fs::create_dir_all(dir.join("demo")).unwrap();
        fs::write(dir.join("demo/SKILL.md"), "---\nname: demo\ndescription: \"Does a thing\"\n---\nBody\n").unwrap();
        fs::create_dir_all(dir.join("not-a-skill")).unwrap();
        let found = list_in(&dir, "yours");
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].name, "demo");
        assert_eq!(found[0].description, "Does a thing");
        fs::remove_dir_all(&dir).unwrap();
    }
}
