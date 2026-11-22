//! File kind from the file name's extension (plan, keputusan 14).
//!
//! Word: docx, docm, doc, dotx, rtf. Excel: xlsx, xlsm, xls, xltx, csv.
//! PDF: pdf. Everything else is "other". Only Word and Excel files get the
//! edit button; the rest are opened read-only.

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DocumentKind {
    Word,
    Excel,
    Pdf,
    Other,
}

const WORD_EXTENSIONS: &[&str] = &["docx", "docm", "doc", "dotx", "rtf"];
const EXCEL_EXTENSIONS: &[&str] = &["xlsx", "xlsm", "xls", "xltx", "csv"];

impl DocumentKind {
    /// Kind from the extension after the last dot, ignoring case. A leading
    /// dot alone (".gitignore") is not an extension.
    pub fn from_file_name(name: &str) -> Self {
        let ext = match name.rfind('.') {
            Some(i) if i > 0 => name[i + 1..].to_ascii_lowercase(),
            _ => return DocumentKind::Other,
        };
        if WORD_EXTENSIONS.contains(&ext.as_str()) {
            DocumentKind::Word
        } else if EXCEL_EXTENSIONS.contains(&ext.as_str()) {
            DocumentKind::Excel
        } else if ext == "pdf" {
            DocumentKind::Pdf
        } else {
            DocumentKind::Other
        }
    }

    /// Stored form (`documents.kind`), same as the JSON form.
    pub fn as_str(self) -> &'static str {
        match self {
            DocumentKind::Word => "word",
            DocumentKind::Excel => "excel",
            DocumentKind::Pdf => "pdf",
            DocumentKind::Other => "other",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "word" => Some(DocumentKind::Word),
            "excel" => Some(DocumentKind::Excel),
            "pdf" => Some(DocumentKind::Pdf),
            "other" => Some(DocumentKind::Other),
            _ => None,
        }
    }

    /// True for kinds Mira opens in Office for editing.
    pub fn editable(self) -> bool {
        matches!(self, DocumentKind::Word | DocumentKind::Excel)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kind_from_extension_ignores_case() {
        for (name, kind) in [
            ("Laporan.docx", DocumentKind::Word),
            ("surat.DOC", DocumentKind::Word),
            ("template.dotx", DocumentKind::Word),
            ("macro.docm", DocumentKind::Word),
            ("catatan.rtf", DocumentKind::Word),
            ("Anggaran 2026.xlsx", DocumentKind::Excel),
            ("lama.xls", DocumentKind::Excel),
            ("data.CSV", DocumentKind::Excel),
            ("macro.xlsm", DocumentKind::Excel),
            ("template.xltx", DocumentKind::Excel),
            ("kontrak.pdf", DocumentKind::Pdf),
            ("foto.jpg", DocumentKind::Other),
            ("README", DocumentKind::Other),
            (".docx", DocumentKind::Other),
            ("arsip.docx.zip", DocumentKind::Other),
            ("titik.", DocumentKind::Other),
        ] {
            assert_eq!(DocumentKind::from_file_name(name), kind, "{name}");
        }
    }

    #[test]
    fn as_str_parse_and_json_agree() {
        for kind in [
            DocumentKind::Word,
            DocumentKind::Excel,
            DocumentKind::Pdf,
            DocumentKind::Other,
        ] {
            assert_eq!(DocumentKind::parse(kind.as_str()), Some(kind));
            assert_eq!(serde_json::to_value(kind).unwrap(), kind.as_str());
        }
        assert_eq!(DocumentKind::parse("Word"), None);
    }

    #[test]
    fn only_word_and_excel_are_editable() {
        assert!(DocumentKind::Word.editable());
        assert!(DocumentKind::Excel.editable());
        assert!(!DocumentKind::Pdf.editable());
        assert!(!DocumentKind::Other.editable());
    }
}
