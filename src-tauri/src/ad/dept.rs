//! Department suggested from directory data (docs/plans/onboarding-ad.md 3.3).

use serde::Serialize;
use unicode_normalization::UnicodeNormalization;

use super::OuMapping;
use super::dn::ous;

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
///
/// First match wins: the attribute as a department name, the attribute as a
/// mapping key, then each OU from innermost out (mapping key before
/// department name). Mappings to a department not in `departments` are
/// skipped. Never invents a department.
pub fn suggest(
    department: Option<&str>,
    dn: Option<&str>,
    departments: &[(String, String)],
    map: &[OuMapping],
) -> DeptSuggestion {
    let attr = department.map(str::trim).filter(|s| !s.is_empty());
    let ou_list = dn.map(ous).unwrap_or_default();
    let ad_department = attr.map(str::to_owned).or_else(|| ou_list.first().cloned());

    let by_name = |text: &str| {
        departments
            .iter()
            .find(|(_, name)| same_text(name, text))
            .map(|(id, _)| id.clone())
    };
    let by_map = |text: &str| {
        map.iter()
            .filter(|row| same_text(&row.ou, text))
            .find_map(|row| departments.iter().find(|(id, _)| *id == row.team))
            .map(|(id, _)| id.clone())
    };

    let attr_hit = attr.and_then(|a| {
        by_name(a)
            .map(|id| (id, DeptSource::Attribute))
            .or_else(|| by_map(a).map(|id| (id, DeptSource::AttributeMap)))
    });
    let hit = attr_hit.or_else(|| {
        ou_list.iter().find_map(|ou| {
            by_map(ou)
                .map(|id| (id, DeptSource::OuMap))
                .or_else(|| by_name(ou).map(|id| (id, DeptSource::OuName)))
        })
    });

    let (team_id, source) = hit.unzip();
    DeptSuggestion {
        in_mira: team_id.is_some(),
        team_id,
        source,
        ad_department,
    }
}

/// Same text for people: NFC, case folded, whitespace collapsed, trimmed.
pub fn same_text(a: &str, b: &str) -> bool {
    text_key(a) == text_key(b)
}

fn text_key(s: &str) -> String {
    let lower = s.nfc().collect::<String>().to_lowercase();
    lower.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    const DN: &str = "CN=hartono,OU=IT-Development,OU=IT-Department,OU=IT & CP Department,OU=HO,OU=Member Users,DC=macf,DC=co,DC=id";

    fn depts() -> Vec<(String, String)> {
        [
            ("t_it", "IT"),
            ("t_dev", "Pengembangan"),
            ("t_hr", "HR"),
            ("t_ho", "HO"),
            ("t_itdept", "IT-Department"),
        ]
        .iter()
        .map(|(i, n)| (i.to_string(), n.to_string()))
        .collect()
    }

    fn map(rows: &[(&str, &str)]) -> Vec<OuMapping> {
        rows.iter()
            .map(|(ou, team)| OuMapping {
                ou: ou.to_string(),
                team: team.to_string(),
            })
            .collect()
    }

    fn found(team: &str, source: DeptSource, ad: &str) -> DeptSuggestion {
        DeptSuggestion {
            team_id: Some(team.to_owned()),
            source: Some(source),
            ad_department: Some(ad.to_owned()),
            in_mira: true,
        }
    }

    #[test]
    fn attribute_equals_department_name() {
        let s = suggest(Some("  hr "), Some(DN), &depts(), &[]);
        assert_eq!(s, found("t_hr", DeptSource::Attribute, "hr"));
    }

    #[test]
    fn attribute_name_beats_attribute_map() {
        let m = map(&[("HR", "t_it")]);
        let s = suggest(Some("HR"), Some(DN), &depts(), &m);
        assert_eq!(s.source, Some(DeptSource::Attribute));
        assert_eq!(s.team_id.as_deref(), Some("t_hr"));
    }

    #[test]
    fn attribute_map() {
        let m = map(&[("Information Technology", "t_it")]);
        let s = suggest(Some("information  technology"), Some(DN), &depts(), &m);
        assert_eq!(
            s,
            found("t_it", DeptSource::AttributeMap, "information  technology")
        );
    }

    #[test]
    fn attribute_map_beats_ous() {
        let m = map(&[("Finance", "t_hr"), ("IT-Development", "t_dev")]);
        let s = suggest(Some("Finance"), Some(DN), &depts(), &m);
        assert_eq!(s.source, Some(DeptSource::AttributeMap));
        assert_eq!(s.team_id.as_deref(), Some("t_hr"));
    }

    #[test]
    fn ou_map() {
        let m = map(&[("it-development", "t_dev")]);
        let s = suggest(None, Some(DN), &depts(), &m);
        assert_eq!(s, found("t_dev", DeptSource::OuMap, "IT-Development"));
    }

    #[test]
    fn ou_name() {
        // IT-Department is the innermost OU that names a Mira department.
        let s = suggest(None, Some(DN), &depts(), &[]);
        assert_eq!(s, found("t_itdept", DeptSource::OuName, "IT-Development"));
    }

    #[test]
    fn ou_map_beats_ou_name_on_same_ou() {
        let m = map(&[("IT-Department", "t_it")]);
        let s = suggest(None, Some(DN), &depts(), &m);
        assert_eq!(s.source, Some(DeptSource::OuMap));
        assert_eq!(s.team_id.as_deref(), Some("t_it"));
    }

    #[test]
    fn innermost_ou_beats_outer_ou() {
        // Mappings on the outer HO and Member Users lose to a name match on
        // the inner IT-Department.
        let m = map(&[("HO", "t_hr"), ("Member Users", "t_it")]);
        let s = suggest(None, Some(DN), &depts(), &m);
        assert_eq!(s.source, Some(DeptSource::OuName));
        assert_eq!(s.team_id.as_deref(), Some("t_itdept"));
    }

    #[test]
    fn mapping_to_missing_team_ignored() {
        let m = map(&[("Finance", "t_gone"), ("IT-Development", "t_gone")]);
        let s = suggest(Some("Finance"), Some(DN), &depts(), &m);
        assert_eq!(s.source, Some(DeptSource::OuName));
        assert_eq!(s.team_id.as_deref(), Some("t_itdept"));
        assert_eq!(s.ad_department.as_deref(), Some("Finance"));
    }

    #[test]
    fn later_mapping_row_used_when_first_points_nowhere() {
        let m = map(&[("Finance", "t_gone"), ("finance", "t_hr")]);
        let s = suggest(Some("Finance"), None, &depts(), &m);
        assert_eq!(s, found("t_hr", DeptSource::AttributeMap, "Finance"));
    }

    #[test]
    fn attribute_not_in_mira() {
        let s = suggest(Some("Finance"), Some("CN=a,OU=Nowhere,DC=x"), &depts(), &[]);
        assert_eq!(
            s,
            DeptSuggestion {
                team_id: None,
                source: None,
                ad_department: Some("Finance".into()),
                in_mira: false,
            }
        );
    }

    #[test]
    fn blank_attribute_uses_innermost_ou() {
        for attr in [None, Some(""), Some("   ")] {
            let s = suggest(attr, Some("CN=a,OU=Nowhere,OU=Outer,DC=x"), &depts(), &[]);
            assert_eq!(s.ad_department.as_deref(), Some("Nowhere"), "{attr:?}");
            assert!(!s.in_mira);
            assert_eq!(s.team_id, None);
        }
    }

    #[test]
    fn blank_attribute_with_ou_match() {
        let s = suggest(Some(" "), Some(DN), &depts(), &[]);
        assert_eq!(s, found("t_itdept", DeptSource::OuName, "IT-Development"));
    }

    #[test]
    fn nothing_known() {
        for dn in [None, Some("CN=a,DC=x"), Some("broken")] {
            let s = suggest(None, dn, &depts(), &[]);
            assert_eq!(
                s,
                DeptSuggestion {
                    team_id: None,
                    source: None,
                    ad_department: None,
                    in_mira: false,
                }
            );
        }
    }

    #[test]
    fn never_matches_without_departments() {
        let m = map(&[("IT-Development", "t_dev")]);
        let s = suggest(Some("IT"), Some(DN), &[], &m);
        assert_eq!(s.team_id, None);
        assert!(!s.in_mira);
        assert_eq!(s.ad_department.as_deref(), Some("IT"));
    }

    #[test]
    fn same_text_rules() {
        assert!(same_text("IT Department", "it department"));
        assert!(same_text("  IT   Department ", "IT Department"));
        assert!(same_text("IT\tDepartment", "IT Department"));
        assert!(same_text("ÉLAN", "élan"));
        // NFC "é" against NFD "e" + combining acute.
        assert!(same_text("Jos\u{e9}", "Jose\u{301}"));
        assert!(same_text("JOSE\u{301}", "jos\u{e9}"));
        assert!(!same_text("IT", "IT-Department"));
        assert!(!same_text("IT Dept", "ITDept"));
        assert!(same_text("", "  "));
    }
}
