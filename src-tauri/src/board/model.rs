//! Types shared with the frontend (`src/api/board.ts`) and input validation.
//!
//! Everything here serializes camelCase to match the TypeScript contract in
//! docs/plans/tahap-3-lokal.md. Validation errors are `AppError::InvalidInput`
//! with an Indonesian message the frontend shows as is.

use serde::{Deserialize, Deserializer, Serialize};
use time::Date;
use time::macros::format_description;

use crate::error::{AppError, AppResult};
use crate::identity;

pub const PROJECT_NAME_MIN_CHARS: usize = 2;
pub const PROJECT_NAME_MAX_CHARS: usize = 80;
pub const TITLE_MAX_CHARS: usize = 200;
pub const DESCRIPTION_MAX_CHARS: usize = 10_000;
pub const LABELS_MAX: usize = 10;
pub const LABEL_MAX_CHARS: usize = 30;
pub const COMMENT_MAX_CHARS: usize = 5_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ColumnId {
    Todo,
    Doing,
    Done,
}

impl ColumnId {
    pub const ALL: [ColumnId; 3] = [ColumnId::Todo, ColumnId::Doing, ColumnId::Done];

    pub fn as_str(self) -> &'static str {
        match self {
            ColumnId::Todo => "todo",
            ColumnId::Doing => "doing",
            ColumnId::Done => "done",
        }
    }

    pub fn parse(s: &str) -> Option<ColumnId> {
        match s {
            "todo" => Some(ColumnId::Todo),
            "doing" => Some(ColumnId::Doing),
            "done" => Some(ColumnId::Done),
            _ => None,
        }
    }

    /// Column name shown on the board (same text as `COLUMN_NAMES` in format.ts).
    pub fn name(self) -> &'static str {
        match self {
            ColumnId::Todo => "To do",
            ColumnId::Doing => "Dikerjakan",
            ColumnId::Done => "Selesai",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Priority {
    #[default]
    None,
    Low,
    Medium,
    High,
}

impl Priority {
    pub fn as_str(self) -> &'static str {
        match self {
            Priority::None => "none",
            Priority::Low => "low",
            Priority::Medium => "medium",
            Priority::High => "high",
        }
    }

    pub fn parse(s: &str) -> Option<Priority> {
        match s {
            "none" => Some(Priority::None),
            "low" => Some(Priority::Low),
            "medium" => Some(Priority::Medium),
            "high" => Some(Priority::High),
            _ => None,
        }
    }

    /// Label shown in the activity history (same text as `PRIORITY_LABELS`).
    pub fn label(self) -> &'static str {
        match self {
            Priority::None => "Tanpa prioritas",
            Priority::Low => "Rendah",
            Priority::Medium => "Sedang",
            Priority::High => "Tinggi",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Person {
    pub public_key: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummary {
    pub id: String,
    pub code: String,
    pub name: String,
    pub team_id: Option<String>,
    pub open_count: u32,
    pub task_count: u32,
    pub can_manage: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskCard {
    pub id: String,
    pub code: String,
    pub title: String,
    pub column_id: ColumnId,
    pub assignee: Option<Person>,
    pub due: Option<String>,
    pub priority: Priority,
    pub labels: Vec<String>,
    pub comment_count: u32,
    /// Changes from another laptop were merged automatically (F-TASK-04).
    /// Always false until board sync exists.
    pub merged: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Column {
    pub id: ColumnId,
    pub name: String,
    pub tasks: Vec<TaskCard>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardView {
    pub project: ProjectSummary,
    pub columns: Vec<Column>,
    pub assignees: Vec<Person>,
    pub me: String,
    pub can_create: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Comment {
    pub id: String,
    pub author: Person,
    pub at: String,
    pub body: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    pub at: String,
    pub actor: Person,
    pub kind: String,
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskDetail {
    #[serde(flatten)]
    pub card: TaskCard,
    pub project_id: String,
    pub description: String,
    pub created_by: Person,
    pub created_at: String,
    pub updated_at: String,
    pub comments: Vec<Comment>,
    pub activity: Vec<Activity>,
    pub can_edit: bool,
    pub can_delete: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MyTask {
    pub project_id: String,
    pub project_code: String,
    pub project_name: String,
    pub task: TaskCard,
}

/// Input of `board_create_task`. Absent and `null` mean the same here.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct NewTask {
    pub title: String,
    pub column_id: Option<ColumnId>,
    pub description: Option<String>,
    pub assignee: Option<String>,
    pub due: Option<String>,
    pub priority: Option<Priority>,
    pub labels: Option<Vec<String>>,
}

/// Input of `board_update_task`. A missing field is left unchanged; for
/// `assignee` and `due`, `Some(None)` (JSON `null`) clears the value.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskPatch {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default, deserialize_with = "present")]
    pub assignee: Option<Option<String>>,
    #[serde(default, deserialize_with = "present")]
    pub due: Option<Option<String>>,
    #[serde(default)]
    pub priority: Option<Priority>,
    #[serde(default)]
    pub labels: Option<Vec<String>>,
}

/// Called only when the field is present, so `null` becomes `Some(None)`.
fn present<'de, D, T>(d: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(d).map(Some)
}

fn invalid(msg: impl Into<String>) -> AppError {
    AppError::InvalidInput(msg.into())
}

/// Control characters other than line breaks and tab, plus the invisible
/// characters `identity::has_forbidden_chars` refuses in names.
fn has_forbidden_multiline_chars(s: &str) -> bool {
    s.split(['\n', '\r', '\t'])
        .any(identity::has_forbidden_chars)
}

/// Trimmed project name, 2 to 80 characters, one line, no invisible characters.
pub fn validate_project_name(name: &str) -> AppResult<String> {
    let name = name.trim();
    let len = name.chars().count();
    if len < PROJECT_NAME_MIN_CHARS {
        return Err(invalid(format!(
            "Nama proyek minimal {PROJECT_NAME_MIN_CHARS} karakter."
        )));
    }
    if len > PROJECT_NAME_MAX_CHARS {
        return Err(invalid(format!(
            "Nama proyek paling banyak {PROJECT_NAME_MAX_CHARS} karakter. Singkat namanya sedikit."
        )));
    }
    if identity::has_forbidden_chars(name) {
        return Err(invalid(
            "Nama proyek berisi karakter yang tidak diizinkan, misalnya baris baru atau tab. Tulis dalam satu baris.",
        ));
    }
    Ok(name.to_owned())
}

/// Team id as sent by the frontend: trimmed, empty means no team.
pub fn normalize_team_id(team_id: Option<&str>) -> Option<&str> {
    team_id.map(str::trim).filter(|t| !t.is_empty())
}

/// Project code: trimmed, uppercased, a letter then 1 to 5 letters or digits.
pub fn validate_project_code(code: &str) -> AppResult<String> {
    let code = code.trim().to_ascii_uppercase();
    let bytes = code.as_bytes();
    let ok = (2..=6).contains(&bytes.len())
        && bytes[0].is_ascii_uppercase()
        && bytes[1..]
            .iter()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit());
    if !ok {
        return Err(invalid(
            "Kode proyek harus 2 sampai 6 karakter, diawali huruf, dan hanya berisi huruf A sampai Z atau angka, misalnya PA atau WEB2.",
        ));
    }
    Ok(code)
}

/// Trimmed task title, 1 to 200 characters, one line.
pub fn validate_title(title: &str) -> AppResult<String> {
    let title = title.trim();
    if title.is_empty() {
        return Err(invalid("Judul task wajib diisi."));
    }
    if title.chars().count() > TITLE_MAX_CHARS {
        return Err(invalid(format!(
            "Judul task paling banyak {TITLE_MAX_CHARS} karakter. Pindahkan rinciannya ke deskripsi."
        )));
    }
    if identity::has_forbidden_chars(title) {
        return Err(invalid(
            "Judul task berisi karakter yang tidak diizinkan, misalnya baris baru atau tab. Tulis dalam satu baris.",
        ));
    }
    Ok(title.to_owned())
}

/// Trimmed description, at most 10000 characters, line breaks allowed.
pub fn validate_description(description: &str) -> AppResult<String> {
    let description = description.trim();
    if description.chars().count() > DESCRIPTION_MAX_CHARS {
        return Err(invalid(format!(
            "Deskripsi paling banyak {DESCRIPTION_MAX_CHARS} karakter. Ringkas isinya atau bagi ke beberapa task."
        )));
    }
    if has_forbidden_multiline_chars(description) {
        return Err(invalid(
            "Deskripsi berisi karakter tak terlihat yang tidak diizinkan. Hapus karakter itu lalu simpan lagi.",
        ));
    }
    Ok(description.to_owned())
}

/// Trimmed labels, each 1 to 30 characters, duplicates (ignoring case)
/// removed keeping the first, at most 10.
pub fn validate_labels(labels: &[String]) -> AppResult<Vec<String>> {
    let mut out: Vec<String> = Vec::new();
    for label in labels {
        let label = label.trim();
        if label.is_empty() {
            return Err(invalid(
                "Label tidak boleh kosong. Hapus label yang kosong.",
            ));
        }
        if label.chars().count() > LABEL_MAX_CHARS {
            return Err(invalid(format!(
                "Setiap label paling banyak {LABEL_MAX_CHARS} karakter."
            )));
        }
        if identity::has_forbidden_chars(label) {
            return Err(invalid(
                "Label berisi karakter yang tidak diizinkan, misalnya baris baru atau tab.",
            ));
        }
        let lower = label.to_lowercase();
        if !out.iter().any(|l| l.to_lowercase() == lower) {
            out.push(label.to_owned());
        }
    }
    if out.len() > LABELS_MAX {
        return Err(invalid(format!(
            "Satu task paling banyak punya {LABELS_MAX} label. Hapus beberapa label dulu."
        )));
    }
    Ok(out)
}

/// Trimmed comment, 1 to 5000 characters, line breaks allowed.
pub fn validate_comment(body: &str) -> AppResult<String> {
    let body = body.trim();
    if body.is_empty() {
        return Err(invalid("Komentar masih kosong. Tulis isinya dulu."));
    }
    if body.chars().count() > COMMENT_MAX_CHARS {
        return Err(invalid(format!(
            "Komentar paling banyak {COMMENT_MAX_CHARS} karakter. Bagi menjadi beberapa komentar."
        )));
    }
    if has_forbidden_multiline_chars(body) {
        return Err(invalid(
            "Komentar berisi karakter tak terlihat yang tidak diizinkan. Hapus karakter itu lalu kirim lagi.",
        ));
    }
    Ok(body.to_owned())
}

/// Due date as `YYYY-MM-DD`, a real calendar date.
pub fn validate_due(due: &str) -> AppResult<String> {
    let due = due.trim();
    let shape_ok = due.len() == 10
        && due.bytes().enumerate().all(|(i, b)| match i {
            4 | 7 => b == b'-',
            _ => b.is_ascii_digit(),
        });
    let date_ok = shape_ok && Date::parse(due, format_description!("[year]-[month]-[day]")).is_ok();
    if !date_ok {
        return Err(invalid(
            "Tanggal tenggat tidak valid. Pilih tanggal dari kalender, formatnya TTTT-BB-HH, misalnya 2026-11-28.",
        ));
    }
    Ok(due.to_owned())
}

/// Lowercase hex id of `len` characters; anything else is reported as not found.
pub fn require_id(id: &str, len: usize, what: &str) -> AppResult<()> {
    if crate::org::is_lower_hex(id, len) {
        Ok(())
    } else {
        Err(AppError::NotFound(format!("{what} tidak ditemukan.")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn code(r: AppResult<String>) -> &'static str {
        r.unwrap_err().code()
    }

    #[test]
    fn project_name_bounds() {
        assert_eq!(validate_project_name("  Ab ").unwrap(), "Ab");
        assert!(validate_project_name(&"é".repeat(80)).is_ok());
        for bad in [
            "",
            " A ",
            &"x".repeat(81),
            "Pro\nyek",
            "Pro\tyek",
            "a\u{202E}b",
        ] {
            assert_eq!(code(validate_project_name(bad)), "invalid_input", "{bad:?}");
        }
    }

    #[test]
    fn project_code_rules() {
        assert_eq!(validate_project_code(" pa ").unwrap(), "PA");
        assert_eq!(validate_project_code("web2").unwrap(), "WEB2");
        assert_eq!(validate_project_code("ABCDEF").unwrap(), "ABCDEF");
        for bad in ["", "P", "1A", "ABCDEFG", "P-A", "PÄ", "P A", "A_1"] {
            assert_eq!(code(validate_project_code(bad)), "invalid_input", "{bad:?}");
        }
    }

    #[test]
    fn team_id_is_normalized() {
        assert_eq!(normalize_team_id(None), None);
        assert_eq!(normalize_team_id(Some("  ")), None);
        assert_eq!(normalize_team_id(Some(" ab ")), Some("ab"));
    }

    #[test]
    fn title_bounds() {
        assert_eq!(validate_title("  Rapat  ").unwrap(), "Rapat");
        assert!(validate_title(&"ü".repeat(200)).is_ok());
        for bad in ["", "   ", &"x".repeat(201), "a\nb", "\u{200B}"] {
            assert_eq!(code(validate_title(bad)), "invalid_input", "{bad:?}");
        }
    }

    #[test]
    fn description_bounds() {
        assert_eq!(validate_description("").unwrap(), "");
        assert_eq!(validate_description(" a\n\tb \r\n").unwrap(), "a\n\tb");
        assert!(validate_description(&"x".repeat(10_000)).is_ok());
        assert_eq!(
            code(validate_description(&"x".repeat(10_001))),
            "invalid_input"
        );
        assert_eq!(code(validate_description("a\u{0}b")), "invalid_input");
        assert_eq!(code(validate_description("a\u{202E}b")), "invalid_input");
    }

    #[test]
    fn labels_trim_dedupe_and_limit() {
        let input: Vec<String> = [" Desain ", "desain", "Web", "DESAIN"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert_eq!(validate_labels(&input).unwrap(), vec!["Desain", "Web"]);
        let ten: Vec<String> = (0..10).map(|i| format!("l{i}")).collect();
        assert_eq!(validate_labels(&ten).unwrap().len(), 10);
        let eleven: Vec<String> = (0..11).map(|i| format!("l{i}")).collect();
        assert_eq!(
            code(validate_labels(&eleven).map(|_| String::new())),
            "invalid_input"
        );
        // Duplicates do not count toward the limit.
        let mut dup = ten.clone();
        dup.push("L0".into());
        assert_eq!(validate_labels(&dup).unwrap().len(), 10);
        for bad in [" ", &"x".repeat(31), "a\nb"] {
            assert_eq!(
                code(validate_labels(&[bad.to_string()]).map(|_| String::new())),
                "invalid_input",
                "{bad:?}"
            );
        }
        assert!(validate_labels(&["x".repeat(30)]).is_ok());
    }

    #[test]
    fn comment_bounds() {
        assert_eq!(validate_comment(" oke\nsiap ").unwrap(), "oke\nsiap");
        assert!(validate_comment(&"x".repeat(5_000)).is_ok());
        for bad in ["", "  \n ", &"x".repeat(5_001), "a\u{7}b"] {
            assert_eq!(code(validate_comment(bad)), "invalid_input", "{bad:?}");
        }
    }

    #[test]
    fn due_dates() {
        assert_eq!(validate_due("2026-11-28").unwrap(), "2026-11-28");
        assert_eq!(validate_due("2028-02-29").unwrap(), "2028-02-29");
        for bad in [
            "",
            "2026-11-31",
            "2026-02-29",
            "2026-13-01",
            "26-11-28",
            "2026/11/28",
            "2026-1-28",
            "2026-11-28T00:00",
            "+2026-11-28",
            "besok",
        ] {
            assert_eq!(code(validate_due(bad)), "invalid_input", "{bad:?}");
        }
    }

    #[test]
    fn messages_have_no_em_dash() {
        let errs = [
            validate_project_name(""),
            validate_project_code(""),
            validate_title(""),
            validate_description(&"x".repeat(10_001)),
            validate_comment(""),
            validate_due("x"),
        ];
        for e in errs {
            assert!(!e.unwrap_err().to_string().contains('\u{2014}'));
        }
    }

    #[test]
    fn patch_distinguishes_absent_from_null() {
        let p: TaskPatch = serde_json::from_str(r#"{"title":"A"}"#).unwrap();
        assert_eq!(p.title.as_deref(), Some("A"));
        assert_eq!(p.assignee, None);
        assert_eq!(p.due, None);
        let p: TaskPatch = serde_json::from_str(r#"{"assignee":null,"due":"2026-11-28"}"#).unwrap();
        assert_eq!(p.assignee, Some(None));
        assert_eq!(p.due, Some(Some("2026-11-28".into())));
        let p: TaskPatch = serde_json::from_str(r#"{"priority":"high","labels":["a"]}"#).unwrap();
        assert_eq!(p.priority, Some(Priority::High));
        assert_eq!(p.labels, Some(vec!["a".into()]));
    }

    #[test]
    fn new_task_defaults() {
        let t: NewTask = serde_json::from_str(r#"{"title":"A"}"#).unwrap();
        assert_eq!(t.column_id, None);
        assert_eq!(t.assignee, None);
        let t: NewTask =
            serde_json::from_str(r#"{"title":"A","columnId":"doing","assignee":null}"#).unwrap();
        assert_eq!(t.column_id, Some(ColumnId::Doing));
    }

    #[test]
    fn enums_serialize_as_contract_strings() {
        for c in ColumnId::ALL {
            assert_eq!(serde_json::to_value(c).unwrap(), c.as_str());
            assert_eq!(ColumnId::parse(c.as_str()), Some(c));
        }
        for p in [
            Priority::None,
            Priority::Low,
            Priority::Medium,
            Priority::High,
        ] {
            assert_eq!(serde_json::to_value(p).unwrap(), p.as_str());
            assert_eq!(Priority::parse(p.as_str()), Some(p));
        }
    }
}
