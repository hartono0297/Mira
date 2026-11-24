//! Approver's re-check of a request's directory claim
//! (docs/plans/onboarding-ad.md 3.4).

use serde::Serialize;

use super::{DirectoryUser, LookupError, OuMapping};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AdCheckStatus {
    Match,
    Mismatch,
    Disabled,
    NotFound,
    Unreachable,
    OtherDomain,
    NotDomainMachine,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AdField {
    Name,
    Department,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdCheckMismatch {
    pub field: AdField,
    pub requested: String,
    pub directory: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdCheck {
    pub status: AdCheckStatus,
    pub mismatches: Vec<AdCheckMismatch>,
    pub directory_name: Option<String>,
    pub directory_department: Option<String>,
    /// The directory's department exists in Mira (false: "belum ada di Mira").
    pub department_in_mira: bool,
    /// RFC 3339.
    pub checked_at: String,
}

#[allow(clippy::too_many_arguments)]
pub fn compare(
    _requested_name: &str,
    _requested_team: &str,
    _requested_team_name: &str,
    _entry: &DirectoryUser,
    _departments: &[(String, String)],
    _map: &[OuMapping],
    checked_at: String,
) -> AdCheck {
    from_error(&LookupError::Unreachable, checked_at)
}

pub fn from_error(_err: &LookupError, checked_at: String) -> AdCheck {
    AdCheck {
        status: AdCheckStatus::Unreachable,
        mismatches: Vec::new(),
        directory_name: None,
        directory_department: None,
        department_in_mira: false,
        checked_at,
    }
}
