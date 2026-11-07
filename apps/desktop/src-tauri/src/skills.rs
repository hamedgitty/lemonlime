//! Skills: folders with a SKILL.md that agents read. LemonLime's own ship with the app;
//! the user's live in `~/.lemonlime/skills` (or `$LEMONLIME_HOME/skills`), which the
//! runner copies into every local thread next to the bundled ones.

use serde::Serialize;
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

#[tauri::command]
pub fn list_skills(app: AppHandle) -> Vec<SkillInfo> {
    let mut out = bundled_dir(&app).map(|d| list_in(&d, "bundled")).unwrap_or_default();
    if let Some(dir) = user_skills_dir() {
        out.extend(list_in(&dir, "yours"));
    }
    out
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
        if entry.file_type()?.is_dir() {
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

#[cfg(test)]
mod tests {
    use super::*;

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
