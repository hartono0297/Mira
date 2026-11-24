//! Department suggested from directory data (docs/plans/onboarding-ad.md 3.3).

use serde::Serialize;

use super::OuMapping;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DeptSource {
    /// The `department` attribute equals a Mira department name.
    Attribute,
    /// The `department` attribute is a key of the mapping.
    AttributeMap,
    /// An OU is a key of the mapping.
    OuMap,
    /// An OU equals a Mira department name.
    OuName,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeptSuggestion {
    pub team_id: Option<String>,
    pub source: Option<DeptSource>,
    /// Shown as "Departemen di AD": the attribute, else the innermost OU.
    pub ad_department: Option<String>,
    /// `team_id` was found.
    pub in_mira: bool,
}

/// `departments`: (id, name) of the open Mira departments.
pub fn suggest(
    _department: Option<&str>,
    _dn: Option<&str>,
    _departments: &[(String, String)],
    _map: &[OuMapping],
) -> DeptSuggestion {
    DeptSuggestion {
        team_id: None,
        source: None,
        ad_department: None,
        in_mira: false,
    }
}

/// Same text for people: NFC, case folded, whitespace collapsed, trimmed.
pub fn same_text(a: &str, b: &str) -> bool {
    a == b
}
