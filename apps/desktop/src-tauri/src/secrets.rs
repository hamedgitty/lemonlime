//! Secrets the app keeps for you (the control plane access token), stored in the
//! operating system's keychain instead of the web view's local storage.

use keyring::Entry;

const SERVICE: &str = "org.lemonlime.desktop";
/// Only these names may be stored, so the web view can't use the keychain for anything else.
const ALLOWED: [&str; 1] = ["control-plane-token"];

fn entry(name: &str) -> Result<Entry, String> {
    if !ALLOWED.contains(&name) {
        return Err(format!("\"{name}\" is not a secret this app stores."));
    }
    Entry::new(SERVICE, name).map_err(|e| format!("Could not open the keychain: {e}"))
}

#[tauri::command]
pub fn secret_get(name: String) -> Result<Option<String>, String> {
    match entry(&name)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("Could not read from the keychain: {e}")),
    }
}

#[tauri::command]
pub fn secret_set(name: String, value: String) -> Result<(), String> {
    let e = entry(&name)?;
    if value.is_empty() {
        return match e.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(err) => Err(format!("Could not remove it from the keychain: {err}")),
        };
    }
    e.set_password(&value).map_err(|err| format!("Could not save to the keychain: {err}"))
}
