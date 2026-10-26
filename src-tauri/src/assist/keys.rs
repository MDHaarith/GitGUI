//! Credential-store migration; legacy files remain intact until storage succeeds.
use super::*;
use std::sync::Mutex;

pub(super) static LOCK: Mutex<()> = Mutex::new(());
type Secret = (String, &'static str);

fn entry(account: &str) -> keyring::Result<keyring::Entry> {
    keyring::Entry::new("com.gitgui.app", account)
}
fn unavailable(error: &keyring::Error) -> bool {
    matches!(error, keyring::Error::PlatformFailure(_))
}
fn storage_error(_: keyring::Error) -> String {
    "Cannot access the OS credential store. Unlock it and try again.".into()
}
pub(super) fn account(provider: &Provider) -> String {
    if provider.kind == "claude" {
        "anthropic".into()
    } else {
        format!("{}:{}", provider.kind, provider.base_url)
    }
}
fn fallback_keys(dir: &Path) -> Result<std::collections::BTreeMap<String, String>> {
    read_file(&dir.join("ai-keys.json"))?
        .map(|text| serde_json::from_str(&text).map_err(|_| "Invalid private key file".into()))
        .transpose()
        .map(Option::unwrap_or_default)
}
fn update_fallback(dir: &Path, account: &str, key: Option<&str>) -> Result<()> {
    let mut keys = fallback_keys(dir)?;
    if let Some(key) = key {
        keys.insert(account.into(), key.into());
    } else {
        keys.remove(account);
    }
    let path = dir.join("ai-keys.json");
    if keys.is_empty() {
        remove(&path)
    } else {
        write_private(
            &path,
            serde_json::to_string(&keys)
                .map_err(|e| e.to_string())?
                .as_bytes(),
        )
    }
}
fn read_file(path: &Path) -> Result<Option<String>> {
    match fs::read_to_string(path) {
        Ok(key) => Ok(Some(key.trim().to_owned()).filter(|key| !key.is_empty())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("Cannot read the saved API key.".into()),
    }
}
fn remove(path: &Path) -> Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("Key is secured, but its old file could not be removed.".into()),
    }
}
// Delete the legacy file only after its key has durable storage.
fn migrate(path: &Path, key: &str, save: impl FnOnce(&str) -> Result<()>) -> Result<()> {
    validate_key(key)?;
    save(key)?;
    remove(path)
}
pub(super) fn save(dir: &Path, account: &str, key: &str) -> Result<&'static str> {
    validate_key(key)?;
    match entry(account).and_then(|entry| entry.set_password(key)) {
        Ok(()) => {
            update_fallback(dir, account, None)?;
            Ok("credential-store")
        }
        Err(error) if unavailable(&error) => {
            update_fallback(dir, account, Some(key))?;
            Ok("private-file")
        }
        Err(error) => Err(storage_error(error)),
    }
}
pub(super) fn load(dir: &Path, account: &str) -> Result<Secret> {
    let saved = fallback_keys(dir)?.remove(account);
    match entry(account).and_then(|entry| entry.get_password()) {
        Ok(key) => {
            // A fallback written while the store was unavailable is the latest key.
            if let Some(saved) = saved {
                entry(account)
                    .and_then(|e| e.set_password(&saved))
                    .map_err(storage_error)?;
                update_fallback(dir, account, None)?;
                return Ok((saved, "credential-store"));
            }
            Ok((key, "credential-store"))
        }
        Err(keyring::Error::NoEntry) => {
            if let Some(key) = saved {
                entry(account)
                    .and_then(|e| e.set_password(&key))
                    .map_err(storage_error)?;
                update_fallback(dir, account, None)?;
                Ok((key, "credential-store"))
            } else {
                Ok((String::new(), "credential-store"))
            }
        }
        Err(error) if unavailable(&error) => Ok((saved.unwrap_or_default(), "private-file")),
        Err(error) => Err(storage_error(error)),
    }
}
pub(super) fn legacy(dir: &Path, provider: &mut Provider) -> Result<()> {
    migrate_legacy(dir, provider, |account, key| {
        save(dir, account, key).map(|_| ())
    })
}
fn migrate_legacy(
    dir: &Path,
    provider: &mut Provider,
    mut store: impl FnMut(&str, &str) -> Result<()>,
) -> Result<()> {
    let path = dir.join("anthropic-key");
    if let Some(key) = read_file(&path)? {
        migrate(&path, &key, |key| store("anthropic", key))?;
    }
    if !provider.api_key.is_empty() {
        store(&account(provider), &provider.api_key)?;
        provider.api_key.clear();
        write_private(
            &dir.join("ai-provider.json"),
            serde_json::to_string_pretty(provider)
                .map_err(|e| e.to_string())?
                .as_bytes(),
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fallback_keys_survive_provider_switches_and_long_addresses() {
        let dir = tempfile::tempdir().unwrap();
        let account = format!("openai:https://example.invalid/{}", "x".repeat(300));
        update_fallback(dir.path(), &account, Some("first")).unwrap();
        update_fallback(dir.path(), "anthropic", Some("second")).unwrap();
        assert_eq!(fallback_keys(dir.path()).unwrap()[&account], "first");
        update_fallback(dir.path(), &account, None).unwrap();
        assert_eq!(fallback_keys(dir.path()).unwrap()["anthropic"], "second");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(dir.path().join("ai-keys.json"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        update_fallback(dir.path(), "anthropic", None).unwrap();
        assert!(!dir.path().join("ai-keys.json").exists());
    }
    #[test]
    fn a_locked_store_never_silently_falls_back_to_disk() {
        assert!(!unavailable(&keyring::Error::NoStorageAccess(Box::new(
            std::io::Error::other("locked")
        ))));
        assert!(unavailable(&keyring::Error::PlatformFailure(Box::new(
            std::io::Error::other("no service")
        ))));
    }
    #[test]
    fn migration_deletes_only_after_success() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("anthropic-key");
        fs::write(&path, "secret").unwrap();
        assert!(migrate(&path, "secret", |_| Err("locked".into())).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "secret");
        migrate(&path, "secret", |key| {
            assert_eq!(key, "secret");
            Ok(())
        })
        .unwrap();
        assert!(!path.exists());
        let mut provider: Provider =
            serde_json::from_str(r#"{"kind":"openai","api_key":"secret"}"#).unwrap();
        assert_eq!(provider.api_key, "secret");
        let config = dir.path().join("ai-provider.json");
        fs::write(&path, "anthropic-secret").unwrap();
        fs::write(&config, r#"{"kind":"openai","api_key":"secret"}"#).unwrap();
        assert!(migrate_legacy(dir.path(), &mut provider, |_, _| Err("locked".into())).is_err());
        assert!(path.exists());
        assert!(fs::read_to_string(&config).unwrap().contains("secret"));
        let mut migrated = Vec::new();
        migrate_legacy(dir.path(), &mut provider, |account, key| {
            migrated.push((account.to_owned(), key.to_owned()));
            Ok(())
        })
        .unwrap();
        assert_eq!(migrated.len(), 2);
        assert_eq!(migrated[0], ("anthropic".into(), "anthropic-secret".into()));
        assert!(!path.exists());
        assert!(provider.api_key.is_empty());
        assert!(!fs::read_to_string(&config).unwrap().contains("secret"));
        assert!(!serde_json::to_string(&provider).unwrap().contains("secret"));
    }
}
