//! macOS Application Firewall: read-only status and guidance (F-ID-03).
//!
//! Mira never changes the macOS firewall itself (no sudo, no prompts of its
//! own). When the firewall is on, macOS asks the user the first time Mira
//! listens whether Mira may accept incoming connections; the UI tells the user
//! to choose Allow, or how to add Mira under System Settings > Network >
//! Firewall > Options. [`admin_command`] is the same change as Terminal
//! commands, for an IT admin to run by hand.
//!
//! The state comes from `socketfilterfw` (`--getglobalstate`,
//! `--getblockall`, `--getappblocked <app>`). Apple does not treat its output
//! as API, so the parsers below look for keywords and the numeric state, and
//! anything they cannot read becomes `rule = unknown` instead of a guess.
//!
//! The firewall tracks apps by bundle, so the `.app` folder that contains the
//! running executable is checked (the executable itself when Mira does not run
//! from a bundle, for example `cargo run`).
//!
//! Compiled on macOS, and in tests everywhere (the parsing is pure).

use std::path::{Path, PathBuf};

use super::{FirewallStatus, Platform, RuleState};

/// Location of the Application Firewall tool on every supported macOS.
pub const SOCKETFILTERFW: &str = "/usr/libexec/ApplicationFirewall/socketfilterfw";
/// Each `socketfilterfw` call gives up after this long, so the UI never hangs.
#[cfg(target_os = "macos")]
const STATUS_TIMEOUT_SECS: u64 = 8;
const DETAIL_MAX_CHARS: usize = 300;

/// Where the firewall settings live, in the words of the Indonesian macOS UI.
const SETTINGS_PATH: &str = "Pengaturan Sistem > Jaringan > Firewall > Pilihan";

/// `--getglobalstate`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GlobalState {
    Off,
    On,
    /// Older macOS reports "block all incoming connections" as state 2.
    BlockAll,
}

/// `--getappblocked`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AppState {
    Permitted,
    Blocked,
    /// The app is not in the firewall list yet: macOS will ask on first listen.
    NotListed,
}

/// Reads the firewall state for `program` (normally `std::env::current_exe()`).
/// Never fails: problems end up as `rule = unknown` with `detail`. Blocks for
/// a few seconds at most; call it off the UI thread.
#[cfg(target_os = "macos")]
pub fn status(program: &Path) -> FirewallStatus {
    let target = firewall_target(program);
    let program_path = target.to_string_lossy().into_owned();
    let admin_command = admin_command(program);
    let target_arg = target.as_os_str();

    let global = match run(&["--getglobalstate".as_ref()]) {
        Ok(out) => match parse_global_state(&out) {
            Some(state) => state,
            None => {
                return unknown(
                    program_path,
                    admin_command,
                    &format!("jawaban socketfilterfw tidak dikenali ({})", out.trim()),
                );
            }
        },
        Err(reason) => return unknown(program_path, admin_command, &reason),
    };
    // Only asked when the firewall is on; a failure here is not fatal.
    let (block_all, app) = if global == GlobalState::Off {
        (None, Ok(AppState::NotListed))
    } else {
        let block_all = run(&["--getblockall".as_ref()])
            .ok()
            .and_then(|out| parse_block_all(&out));
        let app = run(&["--getappblocked".as_ref(), target_arg]).and_then(|out| {
            parse_app_state(&out)
                .ok_or_else(|| format!("jawaban socketfilterfw tidak dikenali ({})", out.trim()))
        });
        (block_all, app)
    };
    let (rule, detail) = evaluate(global, block_all, app);
    FirewallStatus {
        platform: Platform::Macos,
        supported: true,
        rule,
        profiles: Vec::new(),
        program_path,
        admin_command,
        detail,
    }
}

/// Terminal commands an IT admin can run on this Mac: add Mira to the
/// firewall list and allow its incoming connections. Safe to run more than
/// once. Mira only shows this text; it never runs it.
pub fn admin_command(program: &Path) -> String {
    let target = sh_quote(&firewall_target(program).to_string_lossy());
    format!("sudo {SOCKETFILTERFW} --add {target} && sudo {SOCKETFILTERFW} --unblockapp {target}")
}

/// The `.app` bundle holding `program` (`Mira.app/Contents/MacOS/mira` ->
/// `Mira.app`), or `program` itself when it is not inside a bundle.
fn firewall_target(program: &Path) -> PathBuf {
    let bundle = program
        .parent()
        .filter(|dir| dir.file_name().is_some_and(|n| n == "MacOS"))
        .and_then(Path::parent)
        .filter(|dir| dir.file_name().is_some_and(|n| n == "Contents"))
        .and_then(Path::parent)
        .filter(|dir| {
            dir.extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("app"))
        });
    bundle.unwrap_or(program).to_path_buf()
}

/// POSIX shell single-quoted literal (`'` becomes `'\''`).
fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// `Firewall is enabled. (State = 1)`, `Firewall is disabled. (State = 0)`;
/// the number wins over the words when both are there.
fn parse_global_state(out: &str) -> Option<GlobalState> {
    let lower = out.to_ascii_lowercase();
    if let Some(n) = state_number(&lower) {
        return match n {
            0 => Some(GlobalState::Off),
            1 => Some(GlobalState::On),
            2 => Some(GlobalState::BlockAll),
            _ => None,
        };
    }
    on_off(&lower).map(|on| {
        if on {
            GlobalState::On
        } else {
            GlobalState::Off
        }
    })
}

/// `Block all ENABLED!`, `Block all DISABLED!`, or newer wording with
/// "enabled"/"disabled". `None` when neither word is there.
fn parse_block_all(out: &str) -> Option<bool> {
    on_off(&out.to_ascii_lowercase())
}

/// `... is permitted ...`, `... is blocked ...`, or a message that the app is
/// not in the list. `None` for anything else (an error, an empty answer).
fn parse_app_state(out: &str) -> Option<AppState> {
    let lower = out.to_ascii_lowercase();
    if lower.contains("permitted") || lower.contains("not blocked") {
        Some(AppState::Permitted)
    } else if lower.contains("blocked") {
        Some(AppState::Blocked)
    } else if ["not part of", "not found", "does not exist", "not in"]
        .iter()
        .any(|phrase| lower.contains(phrase))
    {
        Some(AppState::NotListed)
    } else {
        None
    }
}

/// The digits after `state =` (`(State = 1)`).
fn state_number(lower: &str) -> Option<u32> {
    let rest = &lower[lower.find("state")? + "state".len()..];
    let rest = rest.trim_start().strip_prefix('=')?.trim_start();
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    digits.parse().ok()
}

/// "disabled" is checked first, since it also contains "abled".
fn on_off(lower: &str) -> Option<bool> {
    if lower.contains("disabled") {
        Some(false)
    } else if lower.contains("enabled") {
        Some(true)
    } else {
        None
    }
}

fn evaluate(
    global: GlobalState,
    block_all: Option<bool>,
    app: Result<AppState, String>,
) -> (RuleState, Option<String>) {
    match global {
        GlobalState::Off => {
            return (
                RuleState::Allowed,
                Some("Firewall macOS sedang mati.".into()),
            );
        }
        GlobalState::BlockAll => return block_all_state(),
        GlobalState::On if block_all == Some(true) => return block_all_state(),
        GlobalState::On => {}
    }
    match app {
        Ok(AppState::Permitted) => (RuleState::Allowed, None),
        Ok(AppState::Blocked) => (
            RuleState::Blocked,
            Some(format!(
                "Di daftar Firewall macOS, Mira diatur untuk memblokir sambungan masuk. Ubah ke Izinkan di {SETTINGS_PATH}."
            )),
        ),
        Ok(AppState::NotListed) => (RuleState::Missing, None),
        Err(reason) => (
            RuleState::Unknown,
            Some(format!(
                "Firewall-nya menyala, tetapi izin untuk Mira tidak terbaca. Keterangan: {}",
                truncate(&reason, DETAIL_MAX_CHARS)
            )),
        ),
    }
}

fn block_all_state() -> (RuleState, Option<String>) {
    (
        RuleState::Blocked,
        Some(format!(
            "Firewall macOS sedang memblokir semua sambungan masuk, termasuk untuk Mira. Matikan pilihan Blokir semua sambungan masuk di {SETTINGS_PATH}."
        )),
    )
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn unknown(program_path: String, admin_command: String, reason: &str) -> FirewallStatus {
    FirewallStatus {
        platform: Platform::Macos,
        supported: true,
        rule: RuleState::Unknown,
        profiles: Vec::new(),
        program_path,
        admin_command,
        detail: Some(format!(
            "Keterangan dari macOS: {}",
            truncate(reason, DETAIL_MAX_CHARS)
        )),
    }
}

fn truncate(s: &str, max_chars: usize) -> String {
    match s.char_indices().nth(max_chars) {
        Some((i, _)) => format!("{}...", &s[..i]),
        None => s.to_owned(),
    }
}

/// Runs `socketfilterfw` with `args` and returns its stdout. `Err` holds an
/// Indonesian reason (could not start, timed out, or exited with an error and
/// no output).
#[cfg(target_os = "macos")]
fn run(args: &[&std::ffi::OsStr]) -> Result<String, String> {
    use std::io::Read;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    let mut child = Command::new(SOCKETFILTERFW)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("socketfilterfw tidak bisa dijalankan ({e})."))?;
    fn reader<R: Read + Send + 'static>(pipe: Option<R>) -> std::thread::JoinHandle<String> {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            if let Some(mut pipe) = pipe {
                let _ = pipe.read_to_end(&mut buf);
            }
            String::from_utf8_lossy(&buf).into_owned()
        })
    }
    let stdout = reader(child.stdout.take());
    let stderr = reader(child.stderr.take());
    let deadline = Instant::now() + Duration::from_secs(STATUS_TIMEOUT_SECS);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "socketfilterfw tidak menjawab dalam {STATUS_TIMEOUT_SECS} detik."
                ));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(e) => {
                let _ = child.kill();
                return Err(format!("socketfilterfw tidak bisa dipantau ({e})."));
            }
        }
    };
    let stdout = stdout.join().unwrap_or_default();
    let stderr = stderr.join().unwrap_or_default();
    if stdout.trim().is_empty() {
        let reason = if stderr.trim().is_empty() {
            format!("socketfilterfw selesai tanpa hasil ({status}).")
        } else {
            stderr.trim().to_owned()
        };
        return Err(reason);
    }
    Ok(stdout)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn global_state_variants() {
        for (out, want) in [
            ("Firewall is enabled. (State = 1)\n", Some(GlobalState::On)),
            (
                "Firewall is disabled. (State = 0)\n",
                Some(GlobalState::Off),
            ),
            (
                "Firewall is set to block all non-essential incoming connections. (State = 2)",
                Some(GlobalState::BlockAll),
            ),
            // The number wins over the words.
            ("Firewall is enabled. (State = 0)", Some(GlobalState::Off)),
            ("Firewall is enabled.", Some(GlobalState::On)),
            ("Firewall is disabled.", Some(GlobalState::Off)),
            ("", None),
            ("Must be root to change settings.", None),
            ("Firewall is weird. (State = 7)", None),
        ] {
            assert_eq!(parse_global_state(out), want, "{out:?}");
        }
    }

    #[test]
    fn block_all_variants() {
        assert_eq!(parse_block_all("Block all DISABLED! \n"), Some(false));
        assert_eq!(parse_block_all("Block all ENABLED! \n"), Some(true));
        assert_eq!(
            parse_block_all("Firewall has block all state set to disabled."),
            Some(false)
        );
        assert_eq!(parse_block_all(""), None);
    }

    #[test]
    fn app_state_variants() {
        for (out, want) in [
            (
                "Incoming connection to the application is permitted\n",
                Some(AppState::Permitted),
            ),
            (
                "The application /Applications/Mira.app is permitted to receive incoming connections.",
                Some(AppState::Permitted),
            ),
            (
                "Incoming connection to /Applications/Mira.app is blocked\n",
                Some(AppState::Blocked),
            ),
            ("The application is not blocked.", Some(AppState::Permitted)),
            (
                "The application is not part of the firewall",
                Some(AppState::NotListed),
            ),
            ("Application not found.", Some(AppState::NotListed)),
            ("", None),
            ("Usage: socketfilterfw ...", None),
        ] {
            assert_eq!(parse_app_state(out), want, "{out:?}");
        }
    }

    #[test]
    fn evaluation() {
        let (rule, detail) = evaluate(GlobalState::Off, None, Ok(AppState::NotListed));
        assert_eq!(rule, RuleState::Allowed);
        assert!(detail.unwrap().contains("mati"));

        assert_eq!(
            evaluate(GlobalState::On, Some(false), Ok(AppState::Permitted)),
            (RuleState::Allowed, None)
        );
        assert_eq!(
            evaluate(GlobalState::On, None, Ok(AppState::NotListed)),
            (RuleState::Missing, None)
        );

        let (rule, detail) = evaluate(GlobalState::On, Some(false), Ok(AppState::Blocked));
        assert_eq!(rule, RuleState::Blocked);
        assert!(detail.unwrap().contains("Izinkan"));

        // "Block all" wins over a permitted app, in both encodings.
        for (global, block_all) in [(GlobalState::On, Some(true)), (GlobalState::BlockAll, None)] {
            let (rule, detail) = evaluate(global, block_all, Ok(AppState::Permitted));
            assert_eq!(rule, RuleState::Blocked);
            assert!(detail.unwrap().contains("semua sambungan masuk"));
        }

        let (rule, detail) = evaluate(GlobalState::On, None, Err("Must be root".into()));
        assert_eq!(rule, RuleState::Unknown);
        assert!(detail.unwrap().contains("Must be root"));
    }

    #[test]
    fn bundle_is_the_firewall_target() {
        assert_eq!(
            firewall_target(Path::new("/Applications/Mira.app/Contents/MacOS/mira")),
            PathBuf::from("/Applications/Mira.app")
        );
        assert_eq!(
            firewall_target(Path::new(
                "/Users/budi/Applications/Mira.APP/Contents/MacOS/Mira"
            )),
            PathBuf::from("/Users/budi/Applications/Mira.APP")
        );
        // Not inside a bundle: the executable itself.
        for exe in [
            "/Users/budi/ChatCompany/src-tauri/target/debug/mira",
            "/tmp/Contents/MacOS/mira",
            "/x/Mira.app/MacOS/mira",
        ] {
            assert_eq!(firewall_target(Path::new(exe)), PathBuf::from(exe));
        }
    }

    #[test]
    fn admin_command_text() {
        let cmd = admin_command(Path::new(
            "/Users/O'Brien/Applications/Mira [dev].app/Contents/MacOS/mira",
        ));
        assert!(!cmd.contains('\n'), "must be one line");
        let quoted = r"'/Users/O'\''Brien/Applications/Mira [dev].app'";
        assert_eq!(
            cmd,
            format!(
                "sudo {SOCKETFILTERFW} --add {quoted} && sudo {SOCKETFILTERFW} --unblockapp {quoted}"
            )
        );
        assert!(!cmd.contains('\u{2014}'));
    }

    #[test]
    fn unknown_keeps_platform_and_truncates() {
        let s = unknown("/a".into(), "cmd".into(), &"x".repeat(400));
        assert_eq!(s.platform, Platform::Macos);
        assert!(s.supported);
        assert_eq!(s.rule, RuleState::Unknown);
        assert!(s.detail.unwrap().ends_with("..."));
    }

    /// Runs the real, read-only status check on this Mac:
    /// `cargo test -- --ignored firewall_status_live --nocapture`.
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "runs socketfilterfw against the real macOS firewall (read only)"]
    fn firewall_status_live() {
        let exe = std::env::var_os("MIRA_FIREWALL_PROBE")
            .map(PathBuf::from)
            .unwrap_or_else(|| std::env::current_exe().unwrap());
        let s = status(&exe);
        println!("{s:#?}");
        assert_eq!(s.platform, Platform::Macos);
        assert_ne!(s.rule, RuleState::Unknown, "{:?}", s.detail);
    }
}
