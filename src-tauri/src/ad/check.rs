//! Approver's re-check of a request's directory claim
//! (docs/plans/onboarding-ad.md 3.4).
//!
//! Two comparisons with the directory entry:
//! - the request itself (display name, chosen Mira department): `name`,
//!   `department`;
//! - what the requester's laptop reported in its AD claim (`displayName`,
//!   `department`, OU path): `claim_name`, `claim_department`, `location`.
//!   A claim that does not match the directory is a sign of a forged claim.
//!
//! `Match` needs at least one of the request's name or department to have
//! been compared; an account that only exists is `Exists`.

use serde::Serialize;

use super::dept::{same_text, suggest};
use super::dn::ous;
use super::{DirectoryUser, LookupError, OuMapping};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AdCheckStatus {
    Match,
    /// The account exists and is enabled, but neither the requested name
    /// nor the requested department could be compared.
    Exists,
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
    /// The request's display name vs `displayName`.
    Name,
    /// The request's Mira department vs the department the directory points to.
    Department,
    /// The claim's `displayName` vs the directory's.
    ClaimName,
    /// The claim's `department` attribute vs the directory's.
    ClaimDepartment,
    /// The claim's OU path vs the directory's.
    Location,
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
    /// OUs of the directory entry's DN, innermost first (not the claim's).
    pub directory_ous: Vec<String>,
    pub directory_department: Option<String>,
    /// The directory's department exists in Mira (false: "belum ada di Mira").
    pub department_in_mira: bool,
    /// RFC 3339.
    pub checked_at: String,
}

/// What the requester's laptop reported in its AD claim.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ClaimFields<'a> {
    pub name: Option<&'a str>,
    pub department: Option<&'a str>,
    pub dn: Option<&'a str>,
}

/// How an OU path is shown in a mismatch: innermost first.
fn ou_path(ous: &[String]) -> String {
    ous.join(" / ")
}

fn present(s: Option<&str>) -> Option<&str> {
    s.filter(|v| !v.trim().is_empty())
}

/// Compares the request and its claim with the directory entry. Each pair
/// is compared only when both sides are present (a blank display name is
/// absent). A directory department missing from Mira is not a mismatch
/// (`department_in_mira: false`). `Disabled` wins over every other status,
/// with the mismatches still listed.
#[allow(clippy::too_many_arguments)]
pub fn compare(
    requested_name: &str,
    requested_team: &str,
    requested_team_name: &str,
    claim: Option<ClaimFields<'_>>,
    entry: &DirectoryUser,
    departments: &[(String, String)],
    map: &[OuMapping],
    checked_at: String,
) -> AdCheck {
    let mut mismatches = Vec::new();
    let mut push = |field, requested: &str, directory: &str| {
        mismatches.push(AdCheckMismatch {
            field,
            requested: requested.to_owned(),
            directory: directory.to_owned(),
        })
    };
    let directory_name = present(entry.display_name.as_deref());
    let directory_ous = ous(&entry.dn);

    if let Some(name) = directory_name
        && !same_text(name, requested_name)
    {
        push(AdField::Name, requested_name, name);
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
        push(AdField::Department, requested_team_name, &directory);
    }
    let compared = directory_name.is_some() || s.team_id.is_some();

    if let Some(c) = claim {
        if let (Some(claimed), Some(dir)) = (present(c.name), directory_name)
            && !same_text(claimed, dir)
        {
            push(AdField::ClaimName, claimed, dir);
        }
        if let (Some(claimed), Some(dir)) =
            (present(c.department), present(entry.department.as_deref()))
            && !same_text(claimed, dir)
        {
            push(AdField::ClaimDepartment, claimed, dir);
        }
        if let Some(dn) = c.dn {
            let claimed = ous(dn);
            let same = claimed.len() == directory_ous.len()
                && claimed
                    .iter()
                    .zip(&directory_ous)
                    .all(|(a, b)| same_text(a, b));
            if !same {
                push(
                    AdField::Location,
                    &ou_path(&claimed),
                    &ou_path(&directory_ous),
                );
            }
        }
    }

    let status = if entry.disabled {
        AdCheckStatus::Disabled
    } else if !mismatches.is_empty() {
        AdCheckStatus::Mismatch
    } else if !compared {
        AdCheckStatus::Exists
    } else {
        AdCheckStatus::Match
    };
    AdCheck {
        status,
        mismatches,
        directory_name: entry.display_name.clone(),
        directory_ous,
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
        directory_ous: Vec::new(),
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
        compare(name, team, team_name, None, e, &depts(), &[], AT.into())
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
                directory_ous: vec!["Sales".into(), "HO".into()],
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
            division: None,
        }];
        let e = entry(Some("Budi"), Some("Penjualan"), DN, false);
        let c = compare("Budi", "t_it", "IT", None, &e, &depts(), &m, AT.into());
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

    fn claim<'a>(
        name: Option<&'a str>,
        department: Option<&'a str>,
        dn: Option<&'a str>,
    ) -> Option<ClaimFields<'a>> {
        Some(ClaimFields {
            name,
            department,
            dn,
        })
    }

    #[test]
    fn exists_when_nothing_of_the_request_is_compared() {
        // No display name, and the directory department is not in Mira.
        let e = entry(None, Some("Finance"), "CN=budi,OU=Nowhere,DC=x,DC=id", false);
        let c = run("Budi", "t_sales", "Sales", &e);
        assert_eq!(c.status, AdCheckStatus::Exists);
        assert!(c.mismatches.is_empty());
        assert_eq!(c.directory_ous, ["Nowhere"]);
        // Matching claim fields do not turn it into a match.
        let c = compare(
            "Budi",
            "t_sales",
            "Sales",
            claim(None, Some("Finance"), Some("CN=b,OU=Nowhere,DC=x,DC=id")),
            &e,
            &depts(),
            &[],
            AT.into(),
        );
        assert_eq!(c.status, AdCheckStatus::Exists);
        // Disabled still wins.
        let off = entry(None, None, "CN=budi,DC=x,DC=id", true);
        assert_eq!(run("Budi", "t_sales", "Sales", &off).status, AdCheckStatus::Disabled);
        assert_eq!(serde_json::to_value(AdCheckStatus::Exists).unwrap(), "exists");
    }

    #[test]
    fn claim_is_compared_with_the_directory() {
        let e = entry(Some("Budi Santoso"), Some("Sales"), DN, false);
        let check = |cl| compare("Budi Santoso", "t_sales", "Sales", cl, &e, &depts(), &[], AT.into());
        // Same claim (case and spacing aside): match.
        let c = check(claim(
            Some("budi  santoso"),
            Some("sales"),
            Some("CN=x,OU=sales,OU=ho,DC=macf,DC=co,DC=id"),
        ));
        assert_eq!(c.status, AdCheckStatus::Match, "{c:?}");
        // Missing claim parts are not compared.
        assert_eq!(check(claim(None, None, None)).status, AdCheckStatus::Match);
        // A forged claim: every part differs.
        let c = check(claim(
            Some("Direktur Utama"),
            Some("Direksi"),
            Some("CN=budi,OU=Direksi,DC=macf,DC=co,DC=id"),
        ));
        assert_eq!(c.status, AdCheckStatus::Mismatch);
        assert_eq!(
            c.mismatches,
            vec![
                AdCheckMismatch {
                    field: AdField::ClaimName,
                    requested: "Direktur Utama".into(),
                    directory: "Budi Santoso".into(),
                },
                AdCheckMismatch {
                    field: AdField::ClaimDepartment,
                    requested: "Direksi".into(),
                    directory: "Sales".into(),
                },
                AdCheckMismatch {
                    field: AdField::Location,
                    requested: "Direksi".into(),
                    directory: "Sales / HO".into(),
                },
            ]
        );
        let v = serde_json::to_value(&c).unwrap();
        assert_eq!(v["mismatches"][0]["field"], "claim_name");
        assert_eq!(v["mismatches"][1]["field"], "claim_department");
        assert_eq!(v["mismatches"][2]["field"], "location");
        assert_eq!(v["directoryOus"], serde_json::json!(["Sales", "HO"]));
        // A claim without OUs against a directory entry with OUs differs too.
        let c = check(claim(None, None, Some("CN=budi,DC=macf,DC=co,DC=id")));
        assert_eq!(c.mismatches[0].field, AdField::Location);
        assert_eq!(c.mismatches[0].requested, "");
        // The directory has no display name: the claim's name is not compared.
        let bare = entry(None, Some("Sales"), DN, false);
        let c = compare("Budi", "t_sales", "Sales", claim(Some("Siapa Saja"), None, None), &bare, &depts(), &[], AT.into());
        assert_eq!(c.status, AdCheckStatus::Match);
        // Disabled wins over a forged claim, which is still listed.
        let off = entry(Some("Budi Santoso"), Some("Sales"), DN, true);
        let c = compare("Budi Santoso", "t_sales", "Sales", claim(Some("Lain"), None, None), &off, &depts(), &[], AT.into());
        assert_eq!(c.status, AdCheckStatus::Disabled);
        assert_eq!(c.mismatches.len(), 1);
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
                    directory_ous: vec![],
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
