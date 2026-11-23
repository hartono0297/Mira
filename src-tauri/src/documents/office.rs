//! Office file-name patterns and the save debounce. See docs/plans/tahap-4-lokal.md (tugas B).
//!
//! Everything here is pure except [`lock_present`], which lists one folder.
//!
//! How Office saves a working copy `<folder>/laporan.docx`:
//! - Word writes `~WRD0000.tmp`, renames `laporan.docx` to `~WRL0001.tmp`, renames the new temp
//!   file to `laporan.docx` and deletes the old one. While the file is open Word keeps a lock
//!   file `~$poran.docx` style: `~$` + the name, with the first one or two characters dropped
//!   for longer names.
//! - Excel does the same dance with a temp file named by 8 hex characters and no extension
//!   (`A1B2C3D4`). Its lock file is `~$` + the full name.
//! - LibreOffice locks with `.~lock.<name>#`.
//!
//! Microsoft Office for Mac (Word, Excel, PowerPoint 16.x) keeps the same `~$` owner file next
//! to the document while it is open, when the folder is writable. Saving goes through a temp
//! file and a replace. The temp names vary by version, for example `~Word Work File ... .tmp`,
//! a hidden `.dat.nosync....` file, a hidden `.sb-<hex>-<suffix>` folder next to the document
//! for sandboxed saves (or a temp folder elsewhere on the same volume), or Excel's
//! 8-hex-character temp file. The final step is a rename onto the document name (an atomic
//! replace, or delete-then-rename like Windows), so the watcher only needs the target
//! name and the lock name; the temp names never matter. Cocoa may write file names in
//! decomposed Unicode (NFD), so names are compared through [`name_key`] (NFC, lowercase).
//!
//! [`SettleTracker`] turns a burst of such events into one "settled" signal per document.

use std::collections::HashMap;
use std::path::Path;
use std::time::{Duration, Instant};

use unicode_normalization::UnicodeNormalization;

/// Comparison key for a file name: NFC, then lowercase. `Café.docx` written as NFD by a macOS
/// app and as NFC by Mira give the same key.
pub fn name_key(file_name: &str) -> String {
    file_name.nfc().collect::<String>().to_lowercase()
}

/// True for files Office (or LibreOffice) creates next to a document while it is open or being
/// saved: lock files (`~$*`, `.~lock.*#`), `*.tmp` (Word `~WRL0001.tmp`, `~WRD0000.tmp`, Word for
/// Mac `~Word Work File L_1234.tmp`), Excel's extensionless 8-hex-character temp files
/// (`A1B2C3D4`), and the hidden macOS save helpers (`.dat.nosync*`, `.sb-*`). Case-insensitive.
pub fn is_office_temp_file(file_name: &str) -> bool {
    let lower = name_key(file_name);
    if lower.starts_with("~$") {
        return true;
    }
    if lower.starts_with(".dat.nosync") || lower.starts_with(".sb-") {
        return true;
    }
    if lower.starts_with(".~lock.") && lower.ends_with('#') {
        return true;
    }
    if lower.ends_with(".tmp") {
        return true;
    }
    file_name.len() == 8 && file_name.bytes().all(|b| b.is_ascii_hexdigit())
}

/// True when `file_name` is an Office or LibreOffice lock file for `target_name`, ignoring case:
/// `~$` + name (Excel, short Word names), `~$` + name without its first one or two characters
/// (Word drops them for longer names, `laporan-bulanan.docx` -> `~$poran-bulanan.docx`), or
/// `.~lock.` + name + `#` (LibreOffice). Office for Mac names its owner files the same way.
/// Unicode normalization does not matter (see [`name_key`]).
pub fn is_lock_file_for(file_name: &str, target_name: &str) -> bool {
    let file = name_key(file_name);
    let target = name_key(target_name);
    if target.is_empty() {
        return false;
    }
    if let Some(rest) = file.strip_prefix(".~lock.") {
        return rest.strip_suffix('#') == Some(target.as_str());
    }
    let Some(rest) = file.strip_prefix("~$") else {
        return false;
    };
    if rest.is_empty() {
        return false;
    }
    if rest == target {
        return true;
    }
    // Word keeps the extension and the tail of the name, so the lock name must be a suffix of
    // the target that is exactly one or two characters shorter.
    let target_chars = target.chars().count();
    let rest_chars = rest.chars().count();
    (rest_chars + 1 == target_chars || rest_chars + 2 == target_chars) && target.ends_with(rest)
}

/// True when the folder of `working_file` holds a lock file for it (the file is open in Office).
/// A folder that cannot be listed counts as "no lock".
pub fn lock_present(working_file: &Path) -> bool {
    let (Some(dir), Some(name)) = (working_file.parent(), working_file.file_name()) else {
        return false;
    };
    let name = name.to_string_lossy();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    entries
        .flatten()
        .any(|entry| is_lock_file_for(&entry.file_name().to_string_lossy(), &name))
}

/// Debounce per document id with an injected clock: an id is due once it has had no `touch` for
/// at least `settle`, and is reported by `due` only once per burst.
#[derive(Debug, Clone)]
pub struct SettleTracker {
    settle: Duration,
    last_touch: HashMap<String, Instant>,
}

impl SettleTracker {
    pub fn new(settle: Duration) -> Self {
        SettleTracker {
            settle,
            last_touch: HashMap::new(),
        }
    }

    /// Records an event for `id` at `now`; the quiet period starts again.
    pub fn touch(&mut self, id: &str, now: Instant) {
        let entry = self.last_touch.entry(id.to_string()).or_insert(now);
        if now > *entry {
            *entry = now;
        }
    }

    /// Ids that have been quiet for at least `settle` at `now`, sorted. Each is removed, so it is
    /// returned once until it is touched again.
    pub fn due(&mut self, now: Instant) -> Vec<String> {
        let settle = self.settle;
        let mut ready: Vec<String> = self
            .last_touch
            .iter()
            .filter(|(_, last)| now.saturating_duration_since(**last) >= settle)
            .map(|(id, _)| id.clone())
            .collect();
        for id in &ready {
            self.last_touch.remove(id);
        }
        ready.sort();
        ready
    }

    /// The earliest moment an id becomes due, or `None` when nothing is pending.
    pub fn next_deadline(&self) -> Option<Instant> {
        self.last_touch
            .values()
            .min()
            .map(|last| *last + self.settle)
    }

    /// Drops any pending burst for `id`.
    pub fn forget(&mut self, id: &str) {
        self.last_touch.remove(id);
    }

    /// True while `id` has a burst that is not due yet (or not collected by `due` yet).
    pub fn is_pending(&self, id: &str) -> bool {
        self.last_touch.contains_key(id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn office_temp_files_are_recognized() {
        for name in [
            "~$poran-bulanan.docx",
            "~$RAB.xlsx",
            "~$surat.docx",
            "~WRL0001.tmp",
            "~WRD0000.tmp",
            "~WRL3125.TMP",
            "~DF1234ABCD.tmp",
            "ppt5A3F.tmp",
            "A1B2C3D4",
            "0f9e8d7c",
            "3E4F2A10",
            ".~lock.laporan.odt#",
            ".~lock.RAB proyek.xlsx#",
            // Office for Mac.
            "~Word Work File L_1234.tmp",
            ".dat.nosync0d4a.3jXWxy",
            ".sb-6c1f02a1-Ab12Cd",
            "Cedd4100",
        ] {
            assert!(is_office_temp_file(name), "{name} should be temp");
        }
    }

    #[test]
    fn name_key_ignores_case_and_unicode_normalization() {
        let nfc = "Caf\u{e9} Proposal.docx";
        let nfd = "Cafe\u{301} proposal.DOCX";
        assert_ne!(nfc, nfd);
        assert_eq!(name_key(nfc), name_key(nfd));
        assert_eq!(name_key("RAB.xlsx"), "rab.xlsx");
    }

    #[test]
    fn mac_lock_names_written_decomposed_still_match() {
        // Word for Mac drops the first two characters of a long name, like Windows, and may
        // write the rest in NFD.
        assert!(is_lock_file_for(
            "~$poran Kafe\u{301} Mei.docx",
            "Laporan Kaf\u{e9} Mei.docx"
        ));
        assert!(is_lock_file_for("~$Re\u{301}sume\u{301}.docx", "R\u{e9}sum\u{e9}.docx"));
        assert!(!is_lock_file_for(
            "~$poran Kafe Mei.docx",
            "Laporan Kaf\u{e9} Mei.docx"
        ));
    }

    #[test]
    fn ordinary_files_are_not_temp() {
        for name in [
            "RAB proyek.xlsx",
            "laporan-bulanan.docx",
            "surat.docx",
            "data.csv",
            "A1B2C3D4.xlsx",
            "ABCDEFGH",
            "A1B2C3D",
            "A1B2C3D45",
            "temp",
            "catatan tmp.docx",
            ".~lock.laporan.odt",
            "~ringkasan.docx",
        ] {
            assert!(!is_office_temp_file(name), "{name} should not be temp");
        }
    }

    #[test]
    fn word_lock_names_short_and_long() {
        // Short names: "~$" + full name.
        assert!(is_lock_file_for("~$surat.docx", "surat.docx"));
        assert!(is_lock_file_for("~$abc.doc", "abc.doc"));
        // Seven characters: Word drops the first one.
        assert!(is_lock_file_for("~$aporan.docx", "laporan.docx"));
        // Longer names: Word drops the first two.
        assert!(is_lock_file_for(
            "~$poran-bulanan.docx",
            "laporan-bulanan.docx"
        ));
        assert!(is_lock_file_for(
            "~$poran bulanan Mei.docx",
            "Laporan bulanan Mei.docx"
        ));
        // Case-insensitive.
        assert!(is_lock_file_for(
            "~$PORAN-BULANAN.DOCX",
            "laporan-bulanan.docx"
        ));
        assert!(is_lock_file_for("~$Surat.docx", "surat.DOCX"));
    }

    #[test]
    fn excel_and_libreoffice_lock_names() {
        assert!(is_lock_file_for("~$RAB proyek.xlsx", "RAB proyek.xlsx"));
        assert!(is_lock_file_for("~$rab proyek.xlsx", "RAB Proyek.xlsx"));
        assert!(is_lock_file_for(
            ".~lock.RAB proyek.xlsx#",
            "RAB proyek.xlsx"
        ));
        assert!(is_lock_file_for(".~lock.laporan.docx#", "Laporan.docx"));
    }

    #[test]
    fn lock_names_for_other_files_do_not_match() {
        assert!(!is_lock_file_for(
            "~$poran-bulanan.docx",
            "laporan-bulanan.xlsx"
        ));
        assert!(!is_lock_file_for("~$ulanan.docx", "laporan-bulanan.docx"));
        assert!(!is_lock_file_for("~$RAB.xlsx", "RAB proyek.xlsx"));
        assert!(!is_lock_file_for("~$", "surat.docx"));
        assert!(!is_lock_file_for(".~lock.laporan.docx", "laporan.docx"));
        assert!(!is_lock_file_for("surat.docx", "surat.docx"));
        assert!(!is_lock_file_for("~WRL0001.tmp", "surat.docx"));
        assert!(!is_lock_file_for("A1B2C3D4", "RAB proyek.xlsx"));
        assert!(!is_lock_file_for("~$x.docx", ""));
    }

    #[test]
    fn lock_present_lists_the_folder() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("laporan-bulanan.docx");
        std::fs::write(&target, b"isi").unwrap();
        std::fs::write(dir.path().join("~WRL0001.tmp"), b"x").unwrap();
        assert!(!lock_present(&target));
        let lock = dir.path().join("~$poran-bulanan.docx");
        std::fs::write(&lock, b"kunci").unwrap();
        assert!(lock_present(&target));
        std::fs::remove_file(&lock).unwrap();
        assert!(!lock_present(&target));
        assert!(!lock_present(&dir.path().join("hilang").join("x.docx")));
    }

    #[test]
    fn burst_becomes_one_due_after_quiet_period() {
        let settle = Duration::from_millis(1500);
        let t0 = Instant::now();
        let mut tracker = SettleTracker::new(settle);
        assert_eq!(tracker.next_deadline(), None);

        tracker.touch("doc", t0);
        tracker.touch("doc", t0 + Duration::from_millis(200));
        tracker.touch("doc", t0 + Duration::from_millis(400));
        assert!(tracker.is_pending("doc"));
        assert_eq!(
            tracker.next_deadline(),
            Some(t0 + Duration::from_millis(400) + settle)
        );

        assert!(tracker.due(t0 + Duration::from_millis(1600)).is_empty());
        assert_eq!(
            tracker.due(t0 + Duration::from_millis(1900)),
            vec!["doc".to_string()]
        );
        // Reported once per burst.
        assert!(tracker.due(t0 + Duration::from_millis(5000)).is_empty());
        assert!(!tracker.is_pending("doc"));
        assert_eq!(tracker.next_deadline(), None);
    }

    #[test]
    fn ids_settle_independently_and_sorted() {
        let settle = Duration::from_millis(100);
        let t0 = Instant::now();
        let mut tracker = SettleTracker::new(settle);
        tracker.touch("b", t0);
        tracker.touch("a", t0);
        tracker.touch("c", t0 + Duration::from_millis(80));
        assert_eq!(tracker.next_deadline(), Some(t0 + settle));
        assert_eq!(
            tracker.due(t0 + Duration::from_millis(100)),
            vec!["a".to_string(), "b".to_string()]
        );
        assert_eq!(
            tracker.next_deadline(),
            Some(t0 + Duration::from_millis(180))
        );
        assert_eq!(
            tracker.due(t0 + Duration::from_millis(180)),
            vec!["c".to_string()]
        );
    }

    #[test]
    fn forget_drops_a_pending_burst() {
        let settle = Duration::from_millis(100);
        let t0 = Instant::now();
        let mut tracker = SettleTracker::new(settle);
        tracker.touch("a", t0);
        tracker.touch("b", t0 + Duration::from_millis(50));
        tracker.forget("a");
        tracker.forget("tidak-ada");
        assert_eq!(
            tracker.next_deadline(),
            Some(t0 + Duration::from_millis(150))
        );
        assert_eq!(
            tracker.due(t0 + Duration::from_millis(1000)),
            vec!["b".to_string()]
        );
    }

    #[test]
    fn touch_with_an_older_instant_does_not_move_the_deadline_back() {
        let settle = Duration::from_millis(100);
        let t0 = Instant::now();
        let mut tracker = SettleTracker::new(settle);
        tracker.touch("a", t0 + Duration::from_millis(50));
        tracker.touch("a", t0);
        assert_eq!(
            tracker.next_deadline(),
            Some(t0 + Duration::from_millis(150))
        );
    }
}
