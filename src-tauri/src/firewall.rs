//! Firewall check for Mira (F-ID-03), shared by Windows and macOS.
//!
//! - Windows ([`windows`]): reads Windows Firewall rules and can create a rule
//!   through an elevated PowerShell (UAC).
//! - macOS ([`macos`]): reads the Application Firewall state and only guides
//!   the user; Mira never changes the macOS firewall.
//!
//! Both report the same [`FirewallStatus`] shape. `platform` tells the UI
//! which instructions to show; `rule` keeps the same four values everywhere.

use std::path::Path;

use serde::Serialize;

use crate::error::AppResult;

#[cfg(any(target_os = "macos", test))]
mod macos;
#[cfg(any(windows, test))]
mod windows;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RuleState {
    Allowed,
    Blocked,
    Missing,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NetCategory {
    Public,
    Private,
    Domain,
}

/// Which firewall the status describes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Platform {
    Windows,
    Macos,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetProfile {
    pub name: String,
    pub category: NetCategory,
    pub interface_alias: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FirewallStatus {
    pub platform: Platform,
    /// `false` outside Windows and macOS.
    pub supported: bool,
    pub rule: RuleState,
    /// Network categories (Windows only; empty on macOS).
    pub profiles: Vec<NetProfile>,
    /// The program the firewall knows Mira by: the exe on Windows, the `.app`
    /// bundle on macOS.
    pub program_path: String,
    /// Command for an IT admin: PowerShell on Windows, Terminal on macOS.
    pub admin_command: String,
    pub detail: Option<String>,
}

/// Reads the firewall state for `program` (normally `std::env::current_exe()`).
/// Never fails: problems end up as `rule = unknown` with `detail`. Blocks for
/// several seconds at most; call it off the UI thread.
pub fn status(program: &Path) -> FirewallStatus {
    #[cfg(windows)]
    {
        windows::status(program)
    }
    #[cfg(target_os = "macos")]
    {
        macos::status(program)
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        FirewallStatus {
            platform: Platform::Other,
            supported: false,
            rule: RuleState::Unknown,
            profiles: Vec::new(),
            program_path: program.to_string_lossy().into_owned(),
            admin_command: String::new(),
            detail: Some("Pemeriksaan firewall hanya tersedia di Windows dan macOS.".into()),
        }
    }
}

/// Windows: asks Windows to create Mira's rule as administrator (UAC prompt).
/// `Ok(true)`: the command ran. `Ok(false)`: the user declined. Changes
/// system settings: never call it from tests. Other systems: an error, since
/// Mira does not change their firewall (the UI shows instructions instead).
pub fn request_rule(program: &Path) -> AppResult<bool> {
    #[cfg(windows)]
    {
        windows::request_rule(program)
    }
    #[cfg(not(windows))]
    {
        let _ = program;
        Err(crate::error::AppError::Internal(
            if cfg!(target_os = "macos") {
                "Di macOS, Mira tidak mengubah firewall sendiri. Izinkan Mira di Pengaturan Sistem > Jaringan > Firewall > Pilihan."
            } else {
                "Pengaturan firewall dari Mira hanya tersedia di Windows."
            }
            .into(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn platform_serializes_for_the_frontend() {
        assert_eq!(serde_json::to_value(Platform::Windows).unwrap(), "windows");
        assert_eq!(serde_json::to_value(Platform::Macos).unwrap(), "macos");
        assert_eq!(serde_json::to_value(Platform::Other).unwrap(), "other");
    }

    #[cfg(not(windows))]
    #[test]
    fn request_rule_never_changes_settings_outside_windows() {
        let err = request_rule(Path::new("/Applications/Mira.app/Contents/MacOS/mira"))
            .unwrap_err();
        assert_eq!(err.code(), "internal");
    }
}
