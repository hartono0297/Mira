//! Approver's re-check of a request's directory claim
//! (docs/plans/onboarding-ad.md 3.4).

use serde::Serialize;

use super::dept::{same_text, suggest};
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

/// Compares what the request claims with the directory entry. A blank
/// display name is not compared; a directory department missing from Mira is
/// not a mismatch (`department_in_mira: false`). A disabled account reports
/// `Disabled` with its mismatches still listed.
#[allow(clippy::too_many_arguments)]
pub fn compare(
    requested_name: &str,
    requested_team: &str,
    requested_team_name: &str,
    entry: &DirectoryUser,
    departments: &[(String, String)],
    map: &[OuMapping],
    checked_at: String,
) -> AdCheck {
    let mut mismatches = Vec::new();

    if let Some(name) = entry.display_name.as_deref()
        && !name.trim().is_empty()
        && !same_text(name, requested_name)
    {
        mismatches.push(AdCheckMismatch {
            field: AdField::Name,
            requested: requested_name.to_owned(),
            directory: name.to_owned(),
        });
    }

    let s = suggest(
        entry.department.as_deref(),
        Some(&entry.dn),
        departments,
        map,
    );
    if let Some(team) = s.team_id.as_deref()
        && team != requested_team
    {
        let directory = s.ad_department.clone().unwrap_or_else(|| {
            departments
                .iter()
                .find(|(id, _)| id == team)
                .map(|(_, name)| name.clone())
                .unwrap_or_default()
        });
        mismatches.push(AdCheckMismatch {
            field: AdField::Department,
            requested: requested_team_name.to_owned(),
            directory,
        });
    }

    let status = if entry.disabled {
        AdCheckStatus::Disabled
    } else if mismatches.is_empty() {
        AdCheckStatus::Match
    } else {
        AdCheckStatus::Mismatch
    };
    AdCheck {
        status,
        mismatches,
        directory_name: entry.display_name.clone(),
        directory_department: s.ad_department,
        department_in_mira: s.in_mira,
        checked_at,
    }
}

/// The check for a lookup that found no usable entry.
pub fn from_error(err: &LookupError, checked_at: String) -> AdCheck {
    let status = match err {
        LookupError::NotDomainMachine => AdCheckStatus::NotDomainMachine,
        LookupError::OtherDomain { .. } => AdCheckStatus::OtherDomain,
        LookupError::Unreachable => AdCheckStatus::Unreachable,
        LookupError::NotFound => AdCheckStatus::NotFound,
    };
    AdCheck {
        status,
        mismatches: Vec::new(),
        directory_name: None,
        directory_department: None,
        department_in_mira: false,
        checked_at,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DN: &str = "CN=budi,OU=Sales,OU=HO,DC=macf,DC=co,DC=id";
    const AT: &str = "2026-11-24T08:00:00Z";

    fn depts() -> Vec<(String, String)> {
        vec![
            ("t_sales".into(), "Sales".into()),
            ("t_it".into(), "IT".into()),
        ]
    }

    fn entry(name: Option<&str>, dept: Option<&str>, dn: &str, disabled: bool) -> DirectoryUser {
        DirectoryUser {
            user: "budi".into(),
            dn: dn.into(),
            display_name: name.map(Into::into),
            department: dept.map(Into::into),
            disabled,
        }
    }

    fn run(name: &str, team: &str, team_name: &str, e: &DirectoryUser) -> AdCheck {
        compare(name, team, team_name, e, &depts(), &[], AT.into())
    }

    #[test]
    fn match_when_all_agree() {
        let e = entry(Some("Budi Santoso"), Some("Sales"), DN, false);
        let c = run("budi  santoso", "t_sales", "Sales", &e);
        assert_eq!(
            c,
            AdCheck {
                status: AdCheckStatus::Match,
                mismatches: vec![],
                directory_name: Some("Budi Santoso".into()),
                directory_department: Some("Sales".into()),
                department_in_mira: true,
                checked_at: AT.into(),
            }
        );
    }

    #[test]
    fn name_differs() {
        let e = entry(Some("Budi Santoso"), Some("Sales"), DN, false);
        let c = run("Budi", "t_sales", "Sales", &e);
        assert_eq!(c.status, AdCheckStatus::Mismatch);
        assert_eq!(
            c.mismatches,
            vec![AdCheckMismatch {
                field: AdField::Name,
                requested: "Budi".into(),
                directory: "Budi Santoso".into(),
            }]
        );
    }

    #[test]
    fn missing_display_name_is_not_a_mismatch() {
        for name in [None, Some(""), Some("  ")] {
            let e = entry(name, Some("Sales"), DN, false);
            let c = run("Anyone", "t_sales", "Sales", &e);
            assert_eq!(c.status, AdCheckStatus::Match, "{name:?}");
            assert_eq!(c.directory_name.as_deref(), name);
        }
    }

    #[test]
    fn department_differs() {
        let e = entry(Some("Budi"), Some("IT"), DN, false);
        let c = run("Budi", "t_sales", "Sales", &e);
        assert_eq!(c.status, AdCheckStatus::Mismatch);
        assert_eq!(
            c.mismatches,
            vec![AdCheckMismatch {
                field: AdField::Department,
                requested: "Sales".into(),
                directory: "IT".into(),
            }]
        );
        assert_eq!(c.directory_department.as_deref(), Some("IT"));
        assert!(c.department_in_mira);
    }

    #[test]
    fn department_from_ou_differs() {
        let e = entry(Some("Budi"), None, DN, false);
        let c = run("Budi", "t_it", "IT", &e);
        assert_eq!(c.status, AdCheckStatus::Mismatch);
        assert_eq!(c.mismatches[0].directory, "Sales");
        assert_eq!(c.directory_department.as_deref(), Some("Sales"));
    }

    #[test]
    fn both_differ() {
        let e = entry(Some("Budi Santoso"), Some("IT"), DN, false);
        let c = run("Budi", "t_sales", "Sales", &e);
        let fields: Vec<_> = c.mismatches.iter().map(|m| m.field).collect();
        assert_eq!(fields, vec![AdField::Name, AdField::Department]);
    }

    #[test]
    fn disabled_wins_and_keeps_mismatches() {
        let e = entry(Some("Budi Santoso"), Some("IT"), DN, true);
        let c = run("Budi", "t_sales", "Sales", &e);
        assert_eq!(c.status, AdCheckStatus::Disabled);
        assert_eq!(c.mismatches.len(), 2);

        let ok = entry(Some("Budi"), Some("Sales"), DN, true);
        let c = run("Budi", "t_sales", "Sales", &ok);
        assert_eq!(c.status, AdCheckStatus::Disabled);
        assert!(c.mismatches.is_empty());
    }

    #[test]
    fn directory_department_not_in_mira_is_not_a_mismatch() {
        let e = entry(
            Some("Budi"),
            Some("Finance"),
            "CN=budi,OU=Nowhere,DC=x",
            false,
        );
        let c = run("Budi", "t_sales", "Sales", &e);
        assert_eq!(c.status, AdCheckStatus::Match);
        assert!(c.mismatches.is_empty());
        assert_eq!(c.directory_department.as_deref(), Some("Finance"));
        assert!(!c.department_in_mira);
    }

    #[test]
    fn mapping_used() {
        let m = vec![OuMapping {
            ou: "Penjualan".into(),
            team: "t_sales".into(),
        }];
        let e = entry(Some("Budi"), Some("Penjualan"), DN, false);
        let c = compare("Budi", "t_it", "IT", &e, &depts(), &m, AT.into());
        assert_eq!(
            c.mismatches,
            vec![AdCheckMismatch {
                field: AdField::Department,
                requested: "IT".into(),
                directory: "Penjualan".into(),
            }]
        );
        assert!(c.department_in_mira);
    }

    #[test]
    fn from_error_each_variant() {
        let cases = [
            (
                LookupError::NotDomainMachine,
                AdCheckStatus::NotDomainMachine,
            ),
            (
                LookupError::OtherDomain {
                    mine: "other.local".into(),
                },
                AdCheckStatus::OtherDomain,
            ),
            (LookupError::Unreachable, AdCheckStatus::Unreachable),
            (LookupError::NotFound, AdCheckStatus::NotFound),
        ];
        for (err, status) in cases {
            assert_eq!(
                from_error(&err, AT.into()),
                AdCheck {
                    status,
                    mismatches: vec![],
                    directory_name: None,
                    directory_department: None,
                    department_in_mira: false,
                    checked_at: AT.into(),
                }
            );
        }
    }

    #[test]
    fn serializes_for_the_frontend() {
        let e = entry(Some("Budi Santoso"), Some("IT"), DN, false);
        let c = run("Budi", "t_sales", "Sales", &e);
        let v = serde_json::to_value(&c).unwrap();
        assert_eq!(v["status"], "mismatch");
        assert_eq!(v["mismatches"][1]["field"], "department");
        assert_eq!(v["departmentInMira"], true);
        assert_eq!(v["checkedAt"], AT);
    }
}
