//! Active Directory for onboarding (docs/plans/onboarding-ad.md).
//!
//! Reads the domain account logged in on this laptop (requester side) and
//! looks an account up in the directory (approver side). Windows only; on
//! other systems every read answers "no domain". Debug builds and tests can
//! replace the directory with `MIRA_FAKE_AD` (`fake.rs`); release builds
//! never compile that module.

pub mod check;
pub mod dept;
pub mod dn;
#[cfg(debug_assertions)]
mod fake;
#[cfg(windows)]
mod windows;

use std::time::Duration;

use serde::{Deserialize, Serialize};

/// Longest wait for reading this laptop's account (onboarding screen).
pub const READ_TIMEOUT: Duration = Duration::from_secs(4);
/// Longest wait for an approver's directory lookup.
pub const LOOKUP_TIMEOUT: Duration = Duration::from_secs(5);

/// One row of the OU to department mapping, also the shape inside the
/// `ad_settings_set` op.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OuMapping {
    pub ou: String,
    /// Department (team) id, 32 hex.
    pub team: String,
}

/// The domain account logged in on this laptop. Any part but `domain` may
/// be missing when the domain controller could not be reached in time.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalAd {
    /// Lowercase DNS domain, `macf.co.id`.
    pub domain: String,
    /// `sAMAccountName`.
    pub user: Option<String>,
    pub dn: Option<String>,
    pub display_name: Option<String>,
    /// The `department` attribute.
    pub department: Option<String>,
    /// false: read only in part (controller unreachable, time out).
    pub complete: bool,
}

/// An account found in the directory from the approver's laptop.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirectoryUser {
    pub user: String,
    pub dn: String,
    pub display_name: Option<String>,
    pub department: Option<String>,
    /// `userAccountControl` has ACCOUNTDISABLE (0x2).
    pub disabled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LookupError {
    /// This laptop is not joined to any domain.
    NotDomainMachine,
    /// This laptop is joined to another domain.
    OtherDomain { mine: String },
    /// No controller answered in time, or the query failed.
    Unreachable,
    /// No account with that `sAMAccountName`.
    NotFound,
}

/// DNS domain this computer is joined to, lowercase. No network access.
pub fn machine_domain() -> Option<String> {
    #[cfg(debug_assertions)]
    if let Some(fake) = fake::load() {
        return fake.machine_domain();
    }
    #[cfg(windows)]
    {
        windows::machine_domain()
    }
    #[cfg(not(windows))]
    {
        None
    }
}

/// The domain account logged in here. `None` for a local account, a
/// computer without a domain, or macOS.
pub async fn read_local(timeout: Duration) -> Option<LocalAd> {
    #[cfg(debug_assertions)]
    if let Some(fake) = fake::load() {
        return fake.read_local(timeout).await;
    }
    #[cfg(windows)]
    {
        windows::read_local(timeout).await
    }
    #[cfg(not(windows))]
    {
        let _ = timeout;
        None
    }
}

/// Looks `user` (`sAMAccountName`) up in `domain`.
pub async fn lookup_user(
    domain: &str,
    user: &str,
    timeout: Duration,
) -> Result<DirectoryUser, LookupError> {
    #[cfg(debug_assertions)]
    if let Some(fake) = fake::load() {
        return fake.lookup_user(domain, user);
    }
    let mine = machine_domain().ok_or(LookupError::NotDomainMachine)?;
    if !same_domain(&mine, domain) {
        return Err(LookupError::OtherDomain { mine });
    }
    #[cfg(windows)]
    {
        windows::lookup_user(mine, user.to_owned(), timeout).await
    }
    #[cfg(not(windows))]
    {
        let _ = (user, timeout);
        Err(LookupError::NotDomainMachine)
    }
}

/// Trimmed, lowercase, without a trailing dot; `None` when empty. Looser
/// than `dn::normalize_domain`: this only tidies names the OS or test data
/// gave us.
fn tidy_domain(s: &str) -> Option<String> {
    let s = s.trim().trim_end_matches('.').to_lowercase();
    (!s.is_empty()).then_some(s)
}

fn same_domain(a: &str, b: &str) -> bool {
    matches!((tidy_domain(a), tidy_domain(b)), (Some(a), Some(b)) if a == b)
}

/// `macf.co.id` → `DC=macf,DC=co,DC=id`.
#[cfg_attr(not(any(windows, debug_assertions)), allow(dead_code))]
fn base_dn(domain: &str) -> String {
    domain
        .split('.')
        .filter(|label| !label.is_empty())
        .map(|label| format!("DC={label}"))
        .collect::<Vec<_>>()
        .join(",")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn domains_compare_loosely() {
        assert!(same_domain("MACF.co.id.", " macf.CO.ID"));
        assert!(!same_domain("macf.co.id", "macf.com"));
        assert!(!same_domain("", ""));
        assert_eq!(tidy_domain("  "), None);
    }

    #[test]
    fn base_dn_from_domain() {
        assert_eq!(base_dn("macf.co.id"), "DC=macf,DC=co,DC=id");
        assert_eq!(base_dn("corp"), "DC=corp");
    }

    /// The real Windows calls on whatever account runs the tests: only
    /// checks that they come back in time without panicking.
    #[cfg(windows)]
    #[tokio::test]
    async fn real_reads_finish_in_time() {
        use std::time::Instant;
        let start = Instant::now();
        let mine = windows::machine_domain();
        assert!(start.elapsed() < Duration::from_secs(2));

        let start = Instant::now();
        let _ = windows::read_local(READ_TIMEOUT).await;
        assert!(start.elapsed() < READ_TIMEOUT + Duration::from_secs(1));

        let domain = mine.unwrap_or_else(|| "mira-test.invalid".to_owned());
        let start = Instant::now();
        let found = windows::lookup_user(domain, "mira-no-such-user".into(), LOOKUP_TIMEOUT).await;
        assert!(start.elapsed() < LOOKUP_TIMEOUT + Duration::from_secs(1));
        assert!(matches!(
            found,
            Err(LookupError::NotFound | LookupError::Unreachable)
        ));
    }
}
