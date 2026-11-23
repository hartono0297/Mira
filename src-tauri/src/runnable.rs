//! File extensions that macOS runs, installs or follows when a file is opened
//! (`open`, double-click), instead of showing it as a document. Documents and
//! chat attachments with these extensions are never opened from Mira; they can
//! only be saved as a copy. The Windows lists live next to their users
//! (`documents::session`, `chat::model`). The check runs on every platform, so
//! a file is treated the same on a MacBook and on a Windows laptop.

/// Lowercase, without the dot.
pub const MACOS_RUNNABLE_EXTENSIONS: &[&str] = &[
    // Apps, installers, disk images, system extensions.
    "app",
    "pkg",
    "mpkg",
    "dmg",
    "kext",
    "prefpane",
    "saver",
    "osax",
    "plugin",
    "bundle",
    "qlgenerator",
    "mobileconfig",
    // Run in Terminal or by an interpreter.
    "command",
    "tool",
    "terminal",
    "sh",
    "bash",
    "zsh",
    "csh",
    "tcsh",
    "ksh",
    "py",
    "pyc",
    "pyw",
    "pl",
    "rb",
    "jnlp",
    // AppleScript and Automator.
    "scpt",
    "scptd",
    "applescript",
    "workflow",
    "action",
    // Links that open another location.
    "webloc",
    "inetloc",
    "fileloc",
];

/// True when `ext` (any case, without the dot) is in
/// [`MACOS_RUNNABLE_EXTENSIONS`].
pub fn is_macos_runnable(ext: &str) -> bool {
    let ext = ext.trim().to_ascii_lowercase();
    MACOS_RUNNABLE_EXTENSIONS.contains(&ext.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn macos_runnable_extensions() {
        for ext in [
            "app", "COMMAND", "sh", "Pkg", "dmg", "scpt", "workflow", "webloc", " py ",
        ] {
            assert!(is_macos_runnable(ext), "{ext}");
        }
        for ext in [
            "docx", "xlsx", "pdf", "png", "", "txt", "pages", "numbers", "key",
        ] {
            assert!(!is_macos_runnable(ext), "{ext}");
        }
        assert!(
            MACOS_RUNNABLE_EXTENSIONS
                .iter()
                .all(|e| *e == e.to_ascii_lowercase() && !e.starts_with('.'))
        );
    }
}
