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
    None
}

/// The domain account logged in here. `None` for a local account, a
/// computer without a domain, or macOS.
pub async fn read_local(_timeout: Duration) -> Option<LocalAd> {
    None
}

/// Looks `user` (`sAMAccountName`) up in `domain`.
pub async fn lookup_user(
    _domain: &str,
    _user: &str,
    _timeout: Duration,
) -> Result<DirectoryUser, LookupError> {
    Err(LookupError::NotDomainMachine)
}
