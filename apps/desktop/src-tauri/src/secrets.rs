//! Secrets the app keeps for you (the control plane access token and the key phones are
//! paired with), stored in the operating system's keychain instead of the web view's local
//! storage.

use keyring::Entry;

const SERVICE: &str = "org.lemonlime.desktop";
/// Only these names may be stored, so the web view can't use the keychain for anything else.
const ALLOWED: [&str; 2] = ["control-plane-token", "phone-pairing-key"];

fn entry(name: &str) -> Result<Entry, String> {
    if !ALLOWED.contains(&name) {
        return Err(format!("\"{name}\" is not a secret this app stores."));
    }
    Entry::new(SERVICE, name).map_err(|e| format!("Could not open the keychain: {e}"))
}

fn read(name: &str) -> Result<Option<String>, String> {
    match entry(name)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("Could not read from the keychain: {e}")),
    }
}

fn write(name: &str, value: &str) -> Result<(), String> {
    let e = entry(name)?;
    if value.is_empty() {
        return match e.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(err) => Err(format!("Could not remove it from the keychain: {err}")),
        };
    }
    e.set_password(value).map_err(|err| format!("Could not save to the keychain: {err}"))
}

// The keychain can stop to ask the user for permission, so it is never used on the
// threads that keep the window responsive.

#[tauri::command]
pub async fn secret_get(name: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || read(&name)).await.map_err(|e| format!("Could not read from the keychain: {e}"))?
}

#[tauri::command]
pub async fn secret_set(name: String, value: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || write(&name, &value)).await.map_err(|e| format!("Could not save to the keychain: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_stores_the_names_it_knows() {
        assert!(entry("anything-else").is_err());
        assert!(entry("phone-pairing-key-2").is_err());
        assert!(read("../control-plane-token").is_err());
        assert!(write("", "x").is_err());
    }
}
