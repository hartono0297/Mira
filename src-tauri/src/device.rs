//! What this laptop reports about itself (v0.3 user list): laptop name,
//! operating system with version, and Mira version. Read only; the values
//! are cleaned so they always pass the `device_set` format checks.

use crate::permissions::DeviceProfile;
use crate::permissions::format::{LAPTOP_NAME_MAX_CHARS, OS_NAME_MAX_CHARS};

/// Mira version from `Cargo.toml`.
pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Keeps printable characters, trims, cuts to `max` characters; `fallback`
/// when nothing is left.
fn clean(s: &str, max: usize, fallback: &str) -> String {
    let kept: String = s
        .chars()
        .filter(|c| !crate::identity::has_forbidden_chars(&c.to_string()))
        .collect();
    let cut: String = kept.trim().chars().take(max).collect();
    let cut = cut.trim().to_owned();
    if cut.is_empty() {
        fallback.to_owned()
    } else {
        cut
    }
}

#[cfg(windows)]
fn raw_laptop_name() -> Option<String> {
    std::env::var("COMPUTERNAME").ok()
}

#[cfg(windows)]
fn raw_os() -> Option<String> {
    use winreg::RegKey;
    use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_QUERY_VALUE};

    let key = RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey_with_flags(
            r"SOFTWARE\Microsoft\Windows NT\CurrentVersion",
            KEY_QUERY_VALUE,
        )
        .ok()?;
    // `ProductName` still says "Windows 10" on Windows 11; the build number
    // tells them apart (Windows 11 starts at 22000).
    let build: u32 = key
        .get_value::<String, _>("CurrentBuildNumber")
        .ok()?
        .trim()
        .parse()
        .ok()?;
    let name = if build >= 22000 {
        "Windows 11"
    } else {
        "Windows 10"
    };
    let display = key
        .get_value::<String, _>("DisplayVersion")
        .ok()
        .filter(|v| !v.trim().is_empty());
    Some(match display {
        Some(v) => format!("{name} {}", v.trim()),
        None => name.to_owned(),
    })
}

#[cfg(target_os = "macos")]
fn command_line(program: &str, args: &[&str]) -> Option<String> {
    use std::process::{Command, Stdio};

    let out = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_owned())
        .filter(|s| !s.is_empty())
}

#[cfg(target_os = "macos")]
fn raw_laptop_name() -> Option<String> {
    command_line("/usr/sbin/scutil", &["--get", "ComputerName"])
}

#[cfg(target_os = "macos")]
fn raw_os() -> Option<String> {
    command_line("/usr/bin/sw_vers", &["-productVersion"]).map(|v| format!("macOS {v}"))
}

#[cfg(not(any(windows, target_os = "macos")))]
fn raw_laptop_name() -> Option<String> {
    std::env::var("HOSTNAME").ok()
}

#[cfg(not(any(windows, target_os = "macos")))]
fn raw_os() -> Option<String> {
    Some(std::env::consts::OS.to_owned())
}

/// This laptop's profile now.
pub fn current() -> DeviceProfile {
    DeviceProfile {
        laptop: clean(
            &raw_laptop_name().unwrap_or_default(),
            LAPTOP_NAME_MAX_CHARS,
            "Laptop tanpa nama",
        ),
        os: clean(
            &raw_os().unwrap_or_default(),
            OS_NAME_MAX_CHARS,
            std::env::consts::OS,
        ),
        app_version: APP_VERSION.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::permissions::format::{
        is_valid_app_version, is_valid_laptop_name, is_valid_os_name,
    };

    #[test]
    fn current_profile_passes_the_op_checks() {
        let d = current();
        assert!(is_valid_laptop_name(&d.laptop), "{:?}", d.laptop);
        assert!(is_valid_os_name(&d.os), "{:?}", d.os);
        assert!(is_valid_app_version(&d.app_version), "{:?}", d.app_version);
    }

    #[test]
    fn clean_strips_control_characters_and_cuts() {
        assert_eq!(clean("  LAPTOP\t-01 \n", 64, "x"), "LAPTOP-01");
        assert_eq!(clean("\u{200B}", 64, "Laptop"), "Laptop");
        assert_eq!(clean(&"a".repeat(80), 64, "x").chars().count(), 64);
    }
}
