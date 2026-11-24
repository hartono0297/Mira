//! Stand-in directory for debug builds and tests (contract 3.1).
//!
//! `MIRA_FAKE_AD` holds JSON (when it starts with `{`) or the path of a
//! JSON file. It is read again on every call so an e2e script can change
//! the file mid-test. A value that cannot be read or parsed acts as a
//! computer without a domain. Release builds never compile this module.

use std::collections::HashMap;
use std::ffi::OsString;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::Deserialize;

use super::{DirectoryUser, LocalAd, LookupError, base_dn, same_domain, tidy_domain};

const VAR: &str = "MIRA_FAKE_AD";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct FakeAd {
    #[serde(default)]
    machine_domain: Option<String>,
    /// `null` or missing: a local account is logged in.
    #[serde(default)]
    local: Option<FakeLocal>,
    /// Drop `dn`, `displayName` and `department`; `complete: false`.
    #[serde(default)]
    local_partial: bool,
    /// Delay before the full local read is ready, under the caller's timeout.
    #[serde(default)]
    local_delay_ms: u64,
    #[serde(default = "yes")]
    reachable: bool,
    /// Keyed by `sAMAccountName`, compared without case.
    #[serde(default)]
    users: HashMap<String, FakeUser>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FakeLocal {
    /// Falls back to `machineDomain`.
    domain: Option<String>,
    user: Option<String>,
    dn: Option<String>,
    display_name: Option<String>,
    department: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FakeUser {
    /// Defaults to `CN=<user>,CN=Users,<domain DN>`.
    dn: Option<String>,
    display_name: Option<String>,
    department: Option<String>,
    #[serde(default)]
    disabled: bool,
}

fn yes() -> bool {
    true
}

/// The stand-in directory when `MIRA_FAKE_AD` is set, read fresh.
pub(super) fn load() -> Option<FakeAd> {
    load_from(std::env::var_os(VAR))
}

/// `load` with the variable's value passed in, so tests need not touch the
/// process environment.
fn load_from(raw: Option<OsString>) -> Option<FakeAd> {
    let raw = raw?;
    let raw = raw.to_string_lossy();
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    let text = if raw.starts_with('{') {
        raw.to_owned()
    } else {
        match std::fs::read_to_string(raw) {
            Ok(text) => text,
            Err(e) => return Some(broken(&format!("cannot read {raw}: {e}"))),
        }
    };
    // Files written by PowerShell often start with a byte order mark.
    match serde_json::from_str(text.trim_start_matches('\u{feff}')) {
        Ok(fake) => Some(fake),
        Err(e) => Some(broken(&format!("invalid JSON: {e}"))),
    }
}

/// Logs once, then answers as a computer without a domain.
fn broken(why: &str) -> FakeAd {
    static WARNED: AtomicBool = AtomicBool::new(false);
    if !WARNED.swap(true, Ordering::Relaxed) {
        eprintln!("{VAR}: {why}; acting as a computer without a domain");
    }
    FakeAd {
        machine_domain: None,
        local: None,
        local_partial: false,
        local_delay_ms: 0,
        reachable: false,
        users: HashMap::new(),
    }
}

fn non_empty(s: &Option<String>) -> Option<String> {
    s.as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

impl FakeAd {
    pub(super) fn machine_domain(&self) -> Option<String> {
        self.machine_domain.as_deref().and_then(tidy_domain)
    }

    /// Like the real read: no machine domain or no domain account → `None`.
    /// On timeout only `domain` and `user` come back, `complete: false`.
    pub(super) async fn read_local(&self, timeout: Duration) -> Option<LocalAd> {
        let machine = self.machine_domain()?;
        let local = self.local.as_ref()?;
        let partial = LocalAd {
            domain: local
                .domain
                .as_deref()
                .and_then(tidy_domain)
                .unwrap_or(machine),
            user: non_empty(&local.user),
            ..LocalAd::default()
        };
        let read = if self.local_partial {
            partial.clone()
        } else {
            LocalAd {
                dn: non_empty(&local.dn),
                display_name: non_empty(&local.display_name),
                department: non_empty(&local.department),
                complete: true,
                ..partial.clone()
            }
        };
        if self.local_delay_ms > 0 {
            let delay = tokio::time::sleep(Duration::from_millis(self.local_delay_ms));
            if tokio::time::timeout(timeout, delay).await.is_err() {
                return Some(partial);
            }
        }
        Some(read)
    }

    pub(super) fn lookup_user(&self, domain: &str, user: &str) -> Result<DirectoryUser, LookupError> {
        let mine = self.machine_domain().ok_or(LookupError::NotDomainMachine)?;
        if !same_domain(&mine, domain) {
            return Err(LookupError::OtherDomain { mine });
        }
        if !self.reachable {
            return Err(LookupError::Unreachable);
        }
        let wanted = user.to_lowercase();
        let (name, found) = self
            .users
            .iter()
            .find(|(name, _)| !wanted.is_empty() && name.to_lowercase() == wanted)
            .ok_or(LookupError::NotFound)?;
        Ok(DirectoryUser {
            user: name.clone(),
            dn: non_empty(&found.dn)
                .unwrap_or_else(|| format!("CN={name},CN=Users,{}", base_dn(&mine))),
            display_name: non_empty(&found.display_name),
            department: non_empty(&found.department),
            disabled: found.disabled,
        })
    }
}

#[cfg(test)]
mod tests {
    use std::time::Instant;

    use super::*;

    const FULL: &str = r#"{
        "machineDomain": "MACF.co.id",
        "local": { "domain": "macf.co.id", "user": "rina",
                   "dn": "CN=rina,OU=Keuangan,DC=macf,DC=co,DC=id",
                   "displayName": "Rina Wijaya", "department": "Keuangan" },
        "localPartial": false,
        "localDelayMs": 0,
        "reachable": true,
        "users": {
            "rina": { "dn": "CN=rina,OU=Keuangan,DC=macf,DC=co,DC=id",
                      "displayName": "Rina Wijaya", "department": "Keuangan", "disabled": false },
            "budi": { "displayName": "Budi", "disabled": true }
        }
    }"#;

    fn fake(json: &str) -> FakeAd {
        load_from(Some(json.into())).expect("fake directory")
    }

    /// `FULL` with top-level fields replaced.
    fn with(patch: &str) -> FakeAd {
        let mut v: serde_json::Value = serde_json::from_str(FULL).unwrap();
        let p: serde_json::Value = serde_json::from_str(patch).unwrap();
        for (k, val) in p.as_object().unwrap() {
            v[k] = val.clone();
        }
        fake(&v.to_string())
    }

    const T: Duration = Duration::from_secs(4);

    #[tokio::test]
    async fn inline_json_full_read() {
        let f = fake(FULL);
        assert_eq!(f.machine_domain().as_deref(), Some("macf.co.id"));
        let read = f.read_local(T).await.unwrap();
        assert_eq!(
            read,
            LocalAd {
                domain: "macf.co.id".into(),
                user: Some("rina".into()),
                dn: Some("CN=rina,OU=Keuangan,DC=macf,DC=co,DC=id".into()),
                display_name: Some("Rina Wijaya".into()),
                department: Some("Keuangan".into()),
                complete: true,
            }
        );
    }

    #[test]
    fn unset_or_empty_is_off() {
        assert!(load_from(None).is_none());
        assert!(load_from(Some("  ".into())).is_none());
    }

    #[tokio::test]
    async fn file_is_read_again_each_call() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ad.json");
        std::fs::write(&path, format!("\u{feff}{FULL}")).unwrap();
        let var = Some(path.clone().into_os_string());
        let first = load_from(var.clone()).unwrap();
        assert_eq!(first.machine_domain().as_deref(), Some("macf.co.id"));
        assert!(first.read_local(T).await.is_some());

        std::fs::write(&path, r#"{ "machineDomain": "other.local", "local": null }"#).unwrap();
        let second = load_from(var).unwrap();
        assert_eq!(second.machine_domain().as_deref(), Some("other.local"));
        assert_eq!(second.read_local(T).await, None);
    }

    #[tokio::test]
    async fn local_null_is_a_local_account() {
        let f = with(r#"{ "local": null }"#);
        assert_eq!(f.read_local(T).await, None);
        assert!(f.machine_domain().is_some());
    }

    #[tokio::test]
    async fn machine_domain_null_is_no_domain() {
        let f = with(r#"{ "machineDomain": null }"#);
        assert_eq!(f.machine_domain(), None);
        assert_eq!(f.read_local(T).await, None);
        assert_eq!(
            f.lookup_user("macf.co.id", "rina"),
            Err(LookupError::NotDomainMachine)
        );
    }

    #[tokio::test]
    async fn partial_drops_directory_fields() {
        let read = with(r#"{ "localPartial": true }"#).read_local(T).await.unwrap();
        assert_eq!(
            read,
            LocalAd {
                domain: "macf.co.id".into(),
                user: Some("rina".into()),
                complete: false,
                ..LocalAd::default()
            }
        );
    }

    #[tokio::test]
    async fn delay_past_timeout_returns_part_quickly() {
        let f = with(r#"{ "localDelayMs": 10000 }"#);
        let start = Instant::now();
        let read = f.read_local(Duration::from_millis(100)).await.unwrap();
        assert!(start.elapsed() < Duration::from_secs(2));
        assert!(!read.complete);
        assert_eq!(read.domain, "macf.co.id");
        assert_eq!(read.user.as_deref(), Some("rina"));
        assert_eq!(read.dn, None);
        assert_eq!(read.display_name, None);
    }

    #[tokio::test]
    async fn delay_within_timeout_is_complete() {
        let f = with(r#"{ "localDelayMs": 20 }"#);
        assert!(f.read_local(T).await.unwrap().complete);
    }

    #[test]
    fn lookup_found_and_disabled() {
        let f = fake(FULL);
        let rina = f.lookup_user("macf.co.id", "RINA").unwrap();
        assert_eq!(rina.user, "rina");
        assert_eq!(rina.dn, "CN=rina,OU=Keuangan,DC=macf,DC=co,DC=id");
        assert_eq!(rina.department.as_deref(), Some("Keuangan"));
        assert!(!rina.disabled);

        let budi = f.lookup_user("Macf.Co.Id", "budi").unwrap();
        assert!(budi.disabled);
        assert_eq!(budi.dn, "CN=budi,CN=Users,DC=macf,DC=co,DC=id");
        assert_eq!(budi.department, None);
    }

    #[test]
    fn lookup_errors() {
        let f = fake(FULL);
        assert_eq!(f.lookup_user("macf.co.id", "nobody"), Err(LookupError::NotFound));
        assert_eq!(f.lookup_user("macf.co.id", ""), Err(LookupError::NotFound));
        assert_eq!(
            f.lookup_user("other.co.id", "rina"),
            Err(LookupError::OtherDomain {
                mine: "macf.co.id".into()
            })
        );
        let offline = with(r#"{ "reachable": false }"#);
        assert_eq!(
            offline.lookup_user("macf.co.id", "rina"),
            Err(LookupError::Unreachable)
        );
    }

    #[tokio::test]
    async fn broken_value_acts_as_no_domain() {
        for raw in ["{ not json", r#"{ "machineDomain": 5 }"#, "Z:\\mira\\no-such-file.json"] {
            let f = load_from(Some(raw.into())).unwrap();
            assert_eq!(f.machine_domain(), None);
            assert_eq!(f.read_local(T).await, None);
            assert_eq!(
                f.lookup_user("macf.co.id", "rina"),
                Err(LookupError::NotDomainMachine)
            );
        }
    }
}
