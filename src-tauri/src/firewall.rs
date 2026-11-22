//! Windows Firewall check and rule for Mira (F-ID-03).
//!
//! [`status`] only reads: it asks PowerShell for the inbound rules whose
//! application filter is this program, the network categories of the active
//! connections, and whether the firewall is on per profile. [`request_rule`]
//! starts an elevated PowerShell (Windows shows UAC, the user decides) that runs
//! the same command [`admin_command`] gives to an IT admin.
//!
//! Rule evaluation follows Windows Firewall semantics rather than "any allow
//! wins": only enabled inbound rules that cover UDP count, a block rule for a
//! profile in use wins over allow rules, and allow rules must cover every
//! profile in use (an allow for Private does not help on a Public network).
//!
//! No separate rule for UDP 5353 (mDNS): Mira's own process receives mDNS, so
//! the program-scoped rule (any local port) already covers it, while a
//! port-only rule would open 5353 to every program on the laptop.

use std::path::Path;

use serde::Serialize;
use serde_json::Value;

use crate::error::{AppError, AppResult};

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
    /// `false` outside Windows.
    pub supported: bool,
    pub rule: RuleState,
    pub profiles: Vec<NetProfile>,
    pub program_path: String,
    pub admin_command: String,
    pub detail: Option<String>,
}

/// Display name of the rule Mira creates.
pub const RULE_DISPLAY_NAME: &str = "Mira";
/// The status check gives up after this long, so the UI never hangs.
pub const STATUS_TIMEOUT_SECS: u64 = 8;
/// How long [`request_rule`] waits for the UAC answer and the rule command.
pub const REQUEST_TIMEOUT_SECS: u64 = 180;
/// Exit code Windows uses when the user declines UAC (ERROR_CANCELLED).
const EXIT_CANCELLED: i32 = 1223;
const DETAIL_MAX_CHARS: usize = 300;

const DOMAIN: u8 = 1;
const PRIVATE: u8 = 2;
const PUBLIC: u8 = 4;
const ALL_PROFILES: u8 = DOMAIN | PRIVATE | PUBLIC;

/// Reads the firewall state for `program` (normally `std::env::current_exe()`).
/// Never fails: problems end up as `rule = unknown` with `detail`. Blocks for
/// up to [`STATUS_TIMEOUT_SECS`]; call it off the UI thread.
pub fn status(program: &Path) -> FirewallStatus {
    let program_path = program_path_string(program);
    let admin_command = admin_command(program);
    status_impl(program_path, admin_command)
}

#[cfg(not(windows))]
fn status_impl(program_path: String, admin_command: String) -> FirewallStatus {
    FirewallStatus {
        supported: false,
        rule: RuleState::Unknown,
        profiles: Vec::new(),
        program_path,
        admin_command,
        detail: Some("Pemeriksaan firewall hanya tersedia di Windows.".into()),
    }
}

#[cfg(windows)]
fn status_impl(program_path: String, admin_command: String) -> FirewallStatus {
    let script = status_script(&program_path);
    let timeout = std::time::Duration::from_secs(STATUS_TIMEOUT_SECS);
    match ps::run(&script, timeout) {
        Ok(out) if !out.stdout.trim().is_empty() => {
            parse_status_output(&out.stdout, program_path, admin_command)
        }
        Ok(out) => {
            let reason = if out.stderr.trim().is_empty() {
                format!("PowerShell selesai tanpa hasil (kode {}).", out.code_text())
            } else {
                out.stderr.trim().to_owned()
            };
            unknown(program_path, admin_command, &reason)
        }
        Err(reason) => unknown(program_path, admin_command, &reason),
    }
}

/// One PowerShell line an IT admin can run as administrator. It disables
/// inbound block rules for this program (for example from declining the
/// Windows "allow access" prompt), then (re)creates one inbound UDP allow
/// rule for this program on all profiles. Safe to run more than once.
pub fn admin_command(program: &Path) -> String {
    let path = program_path_string(program);
    let quoted = ps_quote(&path);
    let wildcard = ps_quote(&ps_wildcard_escape(&path));
    let name = ps_quote(&rule_name(&path));
    format!(
        "$f = @(Get-NetFirewallApplicationFilter -Program {wildcard} -ErrorAction SilentlyContinue); \
         if ($f.Count -gt 0) {{ $f | Get-NetFirewallRule | Where-Object {{ $_.Direction -eq 'Inbound' -and $_.Action -eq 'Block' }} | Disable-NetFirewallRule }}; \
         Remove-NetFirewallRule -Name {name} -ErrorAction SilentlyContinue; \
         New-NetFirewallRule -Name {name} -DisplayName '{RULE_DISPLAY_NAME}' \
         -Description 'Mira: sambungan antarlaptop di jaringan kantor (QUIC dan mDNS)' \
         -Direction Inbound -Program {quoted} -Protocol UDP -Action Allow -Profile Domain,Private,Public"
    )
}

/// Asks Windows to run [`admin_command`] as administrator (UAC prompt).
/// `Ok(true)`: the command ran successfully. `Ok(false)`: the user declined.
/// Blocks until the user answers (up to [`REQUEST_TIMEOUT_SECS`]); call it
/// off the UI thread. Changes system settings: never call it from tests.
pub fn request_rule(program: &Path) -> AppResult<bool> {
    request_rule_impl(program)
}

#[cfg(not(windows))]
fn request_rule_impl(_program: &Path) -> AppResult<bool> {
    Err(AppError::Internal(
        "Pengaturan firewall hanya tersedia di Windows.".into(),
    ))
}

#[cfg(windows)]
fn request_rule_impl(program: &Path) -> AppResult<bool> {
    let script = request_script(program);
    let timeout = std::time::Duration::from_secs(REQUEST_TIMEOUT_SECS);
    let out = ps::run(&script, timeout).map_err(|reason| {
        AppError::Internal(format!(
            "Izin administrator untuk Windows Firewall tidak bisa diminta. Detail: {reason}"
        ))
    })?;
    match out.code {
        Some(0) => Ok(true),
        Some(EXIT_CANCELLED) => Ok(false),
        _ => {
            let detail = if out.stderr.trim().is_empty() {
                format!("kode keluar {}", out.code_text())
            } else {
                truncate(out.stderr.trim(), DETAIL_MAX_CHARS)
            };
            Err(AppError::Internal(format!(
                "Aturan Windows Firewall untuk Mira tidak berhasil dibuat. Minta bantuan admin IT dengan perintah yang tersedia. Detail: {detail}"
            )))
        }
    }
}

/// Path as Windows Firewall stores it: without the `\\?\` verbatim prefix.
pub fn program_path_string(program: &Path) -> String {
    let s = program.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        rest.to_owned()
    } else {
        s.into_owned()
    }
}

/// PowerShell single-quoted literal. PowerShell also treats the typographic
/// single quotes as quote characters, so all of them are doubled.
fn ps_quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for c in s.chars() {
        if matches!(c, '\'' | '\u{2018}' | '\u{2019}' | '\u{201A}' | '\u{201B}') {
            out.push(c);
        }
        out.push(c);
    }
    out.push('\'');
    out
}

/// Escapes PowerShell wildcard characters (the `-Program` filter of
/// `Get-NetFirewallApplicationFilter` treats its argument as a pattern).
fn ps_wildcard_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if matches!(c, '`' | '*' | '?' | '[' | ']') {
            out.push('`');
        }
        out.push(c);
    }
    out
}

/// Stable rule name per program path, so re-running replaces Mira's rule for
/// this exe without touching rules for other copies (dev build, installer).
fn rule_name(path: &str) -> String {
    let hash = blake3::hash(path.to_lowercase().as_bytes());
    format!("Mira-UDP-In-{}", &hash.to_hex()[..16])
}

/// Read-only status script. Prints one JSON object:
/// `{ rules: [...], profiles: [...], firewall: [...], errors: [...] }`.
/// Enum values are cast to strings; the parser also accepts numbers.
#[cfg_attr(not(windows), allow(dead_code))]
fn status_script(path: &str) -> String {
    let quoted = ps_quote(path);
    let wildcard = ps_quote(&ps_wildcard_escape(path));
    format!(
        r#"$ErrorActionPreference = 'Stop'
try {{ [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 }} catch {{}}
$p = {quoted}
$out = [ordered]@{{ rules = @(); profiles = @(); firewall = @(); errors = @() }}
try {{
  $f = @(Get-NetFirewallApplicationFilter -PolicyStore ActiveStore -Program {wildcard} -ErrorAction SilentlyContinue)
  if ($f.Count -eq 0) {{
    try {{
      $f = @(Get-NetFirewallApplicationFilter -PolicyStore ActiveStore | Where-Object {{ $_.Program -like '*%*' -and [System.Environment]::ExpandEnvironmentVariables($_.Program) -ieq $p }})
    }} catch {{}}
  }}
  if ($f.Count -gt 0) {{
    $out.rules = @($f | Get-NetFirewallRule | ForEach-Object {{
      $pf = $_ | Get-NetFirewallPortFilter
      [ordered]@{{ Enabled = [string]$_.Enabled; Action = [string]$_.Action; Direction = [string]$_.Direction; Profile = [string]$_.Profile; Protocol = [string]$pf.Protocol }}
    }})
  }}
}} catch {{ $out.errors += ('rules: ' + $_.Exception.Message) }}
try {{
  $out.profiles = @(Get-NetConnectionProfile -ErrorAction SilentlyContinue | ForEach-Object {{
    [ordered]@{{ Name = [string]$_.Name; InterfaceAlias = [string]$_.InterfaceAlias; NetworkCategory = [string]$_.NetworkCategory }}
  }})
}} catch {{ $out.errors += ('profiles: ' + $_.Exception.Message) }}
try {{
  $out.firewall = @(Get-NetFirewallProfile -PolicyStore ActiveStore | ForEach-Object {{
    [ordered]@{{ Name = [string]$_.Name; Enabled = [string]$_.Enabled }}
  }})
}} catch {{ $out.errors += ('firewall: ' + $_.Exception.Message) }}
[pscustomobject]$out | ConvertTo-Json -Depth 4 -Compress
"#
    )
}

/// Script for [`request_rule`]: starts an elevated, hidden PowerShell running
/// [`admin_command`], waits for it, and exits with its exit code, or 1223 when
/// the user declined UAC.
#[cfg_attr(not(windows), allow(dead_code))]
fn request_script(program: &Path) -> String {
    let inner = format!(
        "$ErrorActionPreference = 'Stop'\n{}\n",
        admin_command(program)
    );
    let encoded = encode_command(&inner);
    let exe = ps_quote(&powershell_exe());
    format!(
        r#"$ErrorActionPreference = 'Stop'
try {{
  $proc = Start-Process -FilePath {exe} -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList '-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand','{encoded}'
  exit [int]$proc.ExitCode
}} catch {{
  $e = $_.Exception
  while ($e) {{
    if ($e -is [System.ComponentModel.Win32Exception] -and $e.NativeErrorCode -eq {EXIT_CANCELLED}) {{ exit {EXIT_CANCELLED} }}
    $e = $e.InnerException
  }}
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}}
"#
    )
}

/// `-EncodedCommand` argument: base64 of the UTF-16LE script. Avoids every
/// command-line quoting problem.
fn encode_command(script: &str) -> String {
    let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    data_encoding::BASE64.encode(&bytes)
}

/// Absolute path of Windows PowerShell, so a `powershell.exe` elsewhere on
/// PATH or next to Mira is never picked.
fn powershell_exe() -> String {
    let root = std::env::var("SystemRoot")
        .ok()
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| r"C:\Windows".into());
    format!(r"{root}\System32\WindowsPowerShell\v1.0\powershell.exe")
}

fn unknown(program_path: String, admin_command: String, reason: &str) -> FirewallStatus {
    FirewallStatus {
        supported: true,
        rule: RuleState::Unknown,
        profiles: Vec::new(),
        program_path,
        admin_command,
        detail: Some(format!(
            "Status Windows Firewall tidak bisa dibaca. Detail: {}",
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

/// One firewall rule reduced to what the evaluation needs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct RawRule {
    enabled: bool,
    inbound: bool,
    action: Action,
    profiles: u8,
    udp: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Action {
    Allow,
    Block,
    Other,
}

/// Turns the status script output into a [`FirewallStatus`].
fn parse_status_output(
    stdout: &str,
    program_path: String,
    admin_command: String,
) -> FirewallStatus {
    let text = stdout.trim().trim_start_matches('\u{feff}');
    if text.is_empty() {
        return unknown(
            program_path,
            admin_command,
            "PowerShell tidak mengembalikan data.",
        );
    }
    let root: Value = match serde_json::from_str(text) {
        Ok(v @ Value::Object(_)) => v,
        _ => {
            return unknown(
                program_path,
                admin_command,
                "Jawaban PowerShell bukan JSON yang dikenali.",
            );
        }
    };

    let profiles: Vec<NetProfile> = as_list(&root["profiles"])
        .into_iter()
        .filter_map(parse_profile)
        .collect();

    let errors: Vec<String> = as_list(&root["errors"])
        .into_iter()
        .filter_map(|v| v.as_str().map(str::to_owned))
        .collect();
    if let Some(err) = errors.iter().find(|e| e.starts_with("rules")) {
        let mut status = unknown(program_path, admin_command, err);
        status.profiles = profiles;
        return status;
    }

    let rules: Vec<RawRule> = as_list(&root["rules"])
        .into_iter()
        .filter_map(parse_rule)
        .collect();

    let mut active = profiles
        .iter()
        .fold(0u8, |acc, p| acc | category_bit(p.category));
    if active == 0 {
        active = ALL_PROFILES;
    }
    let firewall = as_list(&root["firewall"]);
    let firewall_on = if firewall.is_empty() {
        ALL_PROFILES
    } else {
        firewall
            .into_iter()
            .filter(|v| parse_gpo_enabled(&v["Enabled"]))
            .fold(0u8, |acc, v| acc | profile_name_bit(&v["Name"]))
    };

    let (rule, detail) = evaluate(&rules, active, firewall_on);
    FirewallStatus {
        supported: true,
        rule,
        profiles,
        program_path,
        admin_command,
        detail,
    }
}

/// `active`: profiles of the connections in use (all when none).
/// `firewall_on`: profiles where Windows Firewall is enabled.
fn evaluate(rules: &[RawRule], active: u8, firewall_on: u8) -> (RuleState, Option<String>) {
    let relevant = active & firewall_on;
    if relevant == 0 {
        return (
            RuleState::Allowed,
            Some("Windows Firewall sedang mati untuk jaringan yang dipakai sekarang.".into()),
        );
    }
    let counted = rules.iter().filter(|r| r.enabled && r.inbound && r.udp);
    let mut allowed = 0u8;
    for rule in counted {
        match rule.action {
            Action::Block if rule.profiles & relevant != 0 => {
                return (
                    RuleState::Blocked,
                    Some(format!(
                        "Ada aturan Windows Firewall yang memblokir Mira untuk jaringan {}.",
                        profile_names(rule.profiles & relevant)
                    )),
                );
            }
            Action::Allow => allowed |= rule.profiles,
            _ => {}
        }
    }
    let uncovered = relevant & !allowed;
    if uncovered == 0 {
        (RuleState::Allowed, None)
    } else if allowed & ALL_PROFILES != 0 {
        (
            RuleState::Missing,
            Some(format!(
                "Aturan untuk Mira hanya berlaku di jaringan {}, sedangkan jaringan yang dipakai sekarang {}.",
                profile_names(allowed),
                profile_names(uncovered)
            )),
        )
    } else {
        (RuleState::Missing, None)
    }
}

fn profile_names(mask: u8) -> String {
    let names: Vec<&str> = [(DOMAIN, "Domain"), (PRIVATE, "Private"), (PUBLIC, "Public")]
        .into_iter()
        .filter(|(bit, _)| mask & bit != 0)
        .map(|(_, name)| name)
        .collect();
    match names.as_slice() {
        [] => String::new(),
        [one] => (*one).to_owned(),
        [init @ .., last] => format!("{} dan {last}", init.join(", ")),
    }
}

/// `ConvertTo-Json` gives an object for one item and an array for several;
/// Windows PowerShell 5.1 sometimes wraps arrays as `{ value, Count }`.
fn as_list(v: &Value) -> Vec<&Value> {
    match v {
        Value::Null => Vec::new(),
        Value::Array(items) => items.iter().collect(),
        Value::Object(map) if map.contains_key("value") && map.contains_key("Count") => {
            as_list(&map["value"])
        }
        other => vec![other],
    }
}

fn parse_rule(v: &Value) -> Option<RawRule> {
    if !v.is_object() {
        return None;
    }
    // Enabled enum: True = 1, False = 2.
    let enabled = match &v["Enabled"] {
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_i64() == Some(1),
        Value::String(s) => s.eq_ignore_ascii_case("true") || s == "1",
        _ => false,
    };
    // Direction enum: Inbound = 1, Outbound = 2.
    let inbound = match &v["Direction"] {
        Value::Number(n) => n.as_i64() == Some(1),
        Value::String(s) => s.eq_ignore_ascii_case("inbound") || s == "1",
        _ => false,
    };
    // Action enum: NotConfigured = 0, Allow = 2, Block = 4.
    let action = match &v["Action"] {
        Value::Number(n) => match n.as_i64() {
            Some(2) => Action::Allow,
            Some(4) => Action::Block,
            _ => Action::Other,
        },
        Value::String(s) if s.eq_ignore_ascii_case("allow") || s == "2" => Action::Allow,
        Value::String(s) if s.eq_ignore_ascii_case("block") || s == "4" => Action::Block,
        _ => Action::Other,
    };
    Some(RawRule {
        enabled,
        inbound,
        action,
        profiles: parse_profile_mask(&v["Profile"]),
        udp: protocol_covers_udp(&v["Protocol"]),
    })
}

/// Profile flags: Any = 0, Domain = 1, Private = 2, Public = 4; as text
/// `Any` or `Domain, Private`. Unknown values count as all profiles.
fn parse_profile_mask(v: &Value) -> u8 {
    let mask = match v {
        Value::Number(n) => n.as_u64().map(|n| (n & 7) as u8).unwrap_or(0),
        Value::String(s) => {
            if let Ok(n) = s.trim().parse::<u64>() {
                (n & 7) as u8
            } else {
                s.split(',')
                    .map(|part| match part.trim().to_ascii_lowercase().as_str() {
                        "domain" => DOMAIN,
                        "private" => PRIVATE,
                        "public" => PUBLIC,
                        _ => 0,
                    })
                    .fold(0, |acc, bit| acc | bit)
            }
        }
        _ => 0,
    };
    if mask == 0 { ALL_PROFILES } else { mask }
}

/// `Any`, `UDP`, `17`, or empty cover UDP.
fn protocol_covers_udp(v: &Value) -> bool {
    match v {
        Value::Null => true,
        Value::Number(n) => n.as_i64() == Some(17),
        Value::String(s) => {
            let s = s.trim();
            s.is_empty()
                || s.eq_ignore_ascii_case("any")
                || s.eq_ignore_ascii_case("udp")
                || s == "17"
        }
        _ => false,
    }
}

/// `Get-NetFirewallProfile` Enabled is a GpoBoolean: False = 0, True = 1,
/// NotConfigured = 2 (Windows default: on).
fn parse_gpo_enabled(v: &Value) -> bool {
    match v {
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_i64() != Some(0),
        Value::String(s) => !(s.eq_ignore_ascii_case("false") || s == "0"),
        _ => true,
    }
}

fn profile_name_bit(v: &Value) -> u8 {
    match v.as_str().map(|s| s.trim().to_ascii_lowercase()).as_deref() {
        Some("domain") => DOMAIN,
        Some("private") => PRIVATE,
        Some("public") => PUBLIC,
        _ => 0,
    }
}

/// NetworkCategory: Public = 0, Private = 1, DomainAuthenticated = 2.
/// Unknown values are treated as Public (the strictest).
fn parse_profile(v: &Value) -> Option<NetProfile> {
    if !v.is_object() {
        return None;
    }
    let category = match &v["NetworkCategory"] {
        Value::Number(n) => match n.as_i64() {
            Some(1) => NetCategory::Private,
            Some(2) => NetCategory::Domain,
            _ => NetCategory::Public,
        },
        Value::String(s) => match s.trim().to_ascii_lowercase().as_str() {
            "private" | "1" => NetCategory::Private,
            "domainauthenticated" | "domain" | "2" => NetCategory::Domain,
            _ => NetCategory::Public,
        },
        _ => NetCategory::Public,
    };
    let text = |key: &str| v[key].as_str().unwrap_or_default().to_owned();
    Some(NetProfile {
        name: text("Name"),
        category,
        interface_alias: text("InterfaceAlias"),
    })
}

fn category_bit(c: NetCategory) -> u8 {
    match c {
        NetCategory::Domain => DOMAIN,
        NetCategory::Private => PRIVATE,
        NetCategory::Public => PUBLIC,
    }
}

/// Hidden PowerShell runner with a timeout.
#[cfg(windows)]
mod ps {
    use std::io::Read;
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    pub struct Output {
        pub code: Option<i32>,
        pub stdout: String,
        pub stderr: String,
    }

    impl Output {
        pub fn code_text(&self) -> String {
            self.code
                .map(|c| c.to_string())
                .unwrap_or_else(|| "tidak ada".into())
        }
    }

    /// Runs `script` through `-EncodedCommand`. `Err` holds an Indonesian
    /// reason (could not start, or timed out and was stopped).
    pub fn run(script: &str, timeout: Duration) -> Result<Output, String> {
        let mut child = Command::new(super::powershell_exe())
            .args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-EncodedCommand",
                &super::encode_command(script),
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| format!("PowerShell tidak bisa dijalankan ({e})."))?;

        let stdout = child.stdout.take().map(reader);
        let stderr = child.stderr.take().map(reader);
        let deadline = Instant::now() + timeout;
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) if Instant::now() >= deadline => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!(
                        "PowerShell tidak menjawab dalam {} detik.",
                        timeout.as_secs()
                    ));
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(50)),
                Err(e) => {
                    let _ = child.kill();
                    return Err(format!("PowerShell tidak bisa dipantau ({e})."));
                }
            }
        };
        let collect = |h: Option<std::thread::JoinHandle<Vec<u8>>>| {
            h.and_then(|h| h.join().ok())
                .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
                .unwrap_or_default()
        };
        Ok(Output {
            code: status.code(),
            stdout: collect(stdout),
            stderr: collect(stderr),
        })
    }

    fn reader<R: Read + Send + 'static>(mut pipe: R) -> std::thread::JoinHandle<Vec<u8>> {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = pipe.read_to_end(&mut buf);
            buf
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn parse(json: &str) -> FirewallStatus {
        parse_status_output(json, "C:\\Mira\\mira.exe".into(), "cmd".into())
    }

    const PUBLIC_WIFI: &str =
        r#"{"Name":"Kantor","InterfaceAlias":"Wi-Fi","NetworkCategory":"Public"}"#;
    const PRIVATE_LAN: &str =
        r#"{"Name":"LAN","InterfaceAlias":"Ethernet","NetworkCategory":"Private"}"#;

    fn rule(enabled: &str, action: &str, profile: &str, protocol: &str) -> String {
        format!(
            r#"{{"Enabled":"{enabled}","Action":"{action}","Direction":"Inbound","Profile":"{profile}","Protocol":"{protocol}"}}"#
        )
    }

    #[test]
    fn empty_and_garbage_output_is_unknown() {
        for out in ["", "  \r\n", "not json", "[]", "\"x\""] {
            let s = parse(out);
            assert_eq!(s.rule, RuleState::Unknown, "{out:?}");
            assert!(s.supported);
            assert!(s.detail.is_some());
        }
    }

    #[test]
    fn no_rules_is_missing() {
        let s = parse(&format!(
            r#"{{"rules":[],"profiles":{PUBLIC_WIFI},"firewall":[],"errors":[]}}"#
        ));
        assert_eq!(s.rule, RuleState::Missing);
        assert_eq!(s.detail, None);
        assert_eq!(
            s.profiles,
            vec![NetProfile {
                name: "Kantor".into(),
                category: NetCategory::Public,
                interface_alias: "Wi-Fi".into()
            }]
        );
    }

    #[test]
    fn single_object_rule_with_numeric_enums() {
        // One rule, not wrapped in an array, enums as numbers; profile Any.
        let s = parse(
            r#"{"rules":{"Enabled":1,"Action":2,"Direction":1,"Profile":0,"Protocol":"UDP"},
                "profiles":{"Name":"x","InterfaceAlias":"Wi-Fi","NetworkCategory":0},
                "firewall":[{"Name":"Public","Enabled":1}]}"#,
        );
        assert_eq!(s.rule, RuleState::Allowed);
        assert_eq!(s.profiles[0].category, NetCategory::Public);

        // Disabled (2) allow rule does not count.
        let s = parse(
            r#"{"rules":{"Enabled":2,"Action":2,"Direction":1,"Profile":0,"Protocol":"Any"},
                "profiles":{"Name":"x","InterfaceAlias":"Wi-Fi","NetworkCategory":1}}"#,
        );
        assert_eq!(s.rule, RuleState::Missing);
        assert_eq!(s.profiles[0].category, NetCategory::Private);
    }

    #[test]
    fn array_of_rules_and_ps51_value_wrapper() {
        let rules = [
            rule("True", "Allow", "Domain, Private, Public", "UDP"),
            rule("True", "Allow", "Public", "TCP"),
        ]
        .join(",");
        let s = parse(&format!(
            r#"{{"rules":{{"value":[{rules}],"Count":2}},"profiles":[{PUBLIC_WIFI},{PRIVATE_LAN}]}}"#
        ));
        assert_eq!(s.rule, RuleState::Allowed);
        assert_eq!(s.profiles.len(), 2);
    }

    #[test]
    fn block_wins_for_profile_in_use() {
        // What the Windows prompt creates when only "Private" was ticked.
        let rules = [
            rule("True", "Allow", "Private", "UDP"),
            rule("True", "Block", "Public", "UDP"),
        ]
        .join(",");
        let on_public = parse(&format!(
            r#"{{"rules":[{rules}],"profiles":{PUBLIC_WIFI}}}"#
        ));
        assert_eq!(on_public.rule, RuleState::Blocked);
        assert!(on_public.detail.unwrap().contains("Public"));

        let on_private = parse(&format!(
            r#"{{"rules":[{rules}],"profiles":{PRIVATE_LAN}}}"#
        ));
        assert_eq!(on_private.rule, RuleState::Allowed);
    }

    #[test]
    fn allow_for_other_profile_only_is_missing() {
        let s = parse(&format!(
            r#"{{"rules":[{}],"profiles":{PUBLIC_WIFI}}}"#,
            rule("True", "Allow", "Private", "UDP")
        ));
        assert_eq!(s.rule, RuleState::Missing);
        let detail = s.detail.unwrap();
        assert!(
            detail.contains("Private") && detail.contains("Public"),
            "{detail}"
        );
    }

    #[test]
    fn tcp_only_and_outbound_rules_do_not_count() {
        let s = parse(&format!(
            r#"{{"rules":[{},{}],"profiles":{PRIVATE_LAN}}}"#,
            rule("True", "Allow", "Any", "TCP"),
            r#"{"Enabled":"True","Action":"Allow","Direction":"Outbound","Profile":"Any","Protocol":"UDP"}"#
        ));
        assert_eq!(s.rule, RuleState::Missing);
    }

    #[test]
    fn no_connection_needs_all_profiles() {
        let partial = parse(&format!(
            r#"{{"rules":[{}],"profiles":[]}}"#,
            rule("True", "Allow", "Domain, Private", "UDP")
        ));
        assert_eq!(partial.rule, RuleState::Missing);
        let full = parse(&format!(
            r#"{{"rules":[{}],"profiles":null}}"#,
            rule("True", "Allow", "Any", "17")
        ));
        assert_eq!(full.rule, RuleState::Allowed);
    }

    #[test]
    fn firewall_off_for_active_profile_is_allowed() {
        let s = parse(&format!(
            r#"{{"rules":[],"profiles":{PUBLIC_WIFI},
                "firewall":[{{"Name":"Public","Enabled":"False"}},{{"Name":"Private","Enabled":"True"}}]}}"#
        ));
        assert_eq!(s.rule, RuleState::Allowed);
        assert!(s.detail.unwrap().contains("mati"));

        let numeric = parse(&format!(
            r#"{{"rules":[],"profiles":{PUBLIC_WIFI},"firewall":[{{"Name":"Public","Enabled":0}}]}}"#
        ));
        assert_eq!(numeric.rule, RuleState::Allowed);
    }

    #[test]
    fn rule_query_error_is_unknown() {
        let s = parse(&format!(
            r#"{{"rules":[],"profiles":[{PRIVATE_LAN}],"errors":"rules: Access is denied."}}"#
        ));
        assert_eq!(s.rule, RuleState::Unknown);
        assert!(s.detail.unwrap().contains("Access is denied"));
        assert_eq!(s.profiles.len(), 1);

        // A failed profile query alone does not hide the rule state.
        let s = parse(&format!(
            r#"{{"rules":[{}],"errors":["profiles: x"]}}"#,
            rule("True", "Allow", "Any", "UDP")
        ));
        assert_eq!(s.rule, RuleState::Allowed);
    }

    #[test]
    fn domain_authenticated_category() {
        let s = parse(
            r#"{"rules":[],"profiles":[{"Name":"corp","InterfaceAlias":"Ethernet","NetworkCategory":"DomainAuthenticated"},
                {"Name":"y","InterfaceAlias":"z","NetworkCategory":2}]}"#,
        );
        assert!(s.profiles.iter().all(|p| p.category == NetCategory::Domain));
    }

    #[test]
    fn serializes_to_frontend_shape() {
        let s = FirewallStatus {
            supported: true,
            rule: RuleState::Missing,
            profiles: vec![NetProfile {
                name: "LAN".into(),
                category: NetCategory::Private,
                interface_alias: "Ethernet".into(),
            }],
            program_path: "C:\\Mira\\mira.exe".into(),
            admin_command: "cmd".into(),
            detail: None,
        };
        let json = serde_json::to_value(&s).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "supported": true,
                "rule": "missing",
                "profiles": [{ "name": "LAN", "category": "private", "interfaceAlias": "Ethernet" }],
                "programPath": "C:\\Mira\\mira.exe",
                "adminCommand": "cmd",
                "detail": null
            })
        );
    }

    #[test]
    fn quoting_and_escaping() {
        assert_eq!(ps_quote("C:\\a b\\m.exe"), "'C:\\a b\\m.exe'");
        assert_eq!(ps_quote("O'Brien"), "'O''Brien'");
        assert_eq!(ps_quote("a\u{2019}b"), "'a\u{2019}\u{2019}b'");
        assert_eq!(
            ps_wildcard_escape("C:\\[x]\\a*?`.exe"),
            "C:\\`[x`]\\a`*`?``.exe"
        );
        assert_eq!(
            program_path_string(Path::new(r"\\?\C:\Mira\mira.exe")),
            r"C:\Mira\mira.exe"
        );
        assert_eq!(
            program_path_string(Path::new(r"\\?\UNC\srv\share\mira.exe")),
            r"\\srv\share\mira.exe"
        );
        // base64 of UTF-16LE "a" (61 00).
        assert_eq!(encode_command("a"), "YQA=");
    }

    #[test]
    fn admin_command_text() {
        let program = PathBuf::from(r"C:\Users\O'Brien\AppData\Local\Mira [dev]\mira.exe");
        let cmd = admin_command(&program);
        assert!(!cmd.contains('\n'), "must be one line");
        assert!(cmd.contains(
            r"-Direction Inbound -Program 'C:\Users\O''Brien\AppData\Local\Mira [dev]\mira.exe' -Protocol UDP -Action Allow -Profile Domain,Private,Public"
        ));
        assert!(cmd.contains(
            r"Get-NetFirewallApplicationFilter -Program 'C:\Users\O''Brien\AppData\Local\Mira `[dev`]\mira.exe'"
        ));
        assert!(cmd.contains("-DisplayName 'Mira'"));
        let name = rule_name(&program_path_string(&program));
        assert!(cmd.contains(&format!("Remove-NetFirewallRule -Name '{name}'")));
        assert!(cmd.contains(&format!("New-NetFirewallRule -Name '{name}'")));
        // Program-scoped, any local port: covers QUIC and mDNS without a
        // separate port rule.
        assert!(!cmd.contains("LocalPort") && !cmd.contains("5353"));
        assert!(!cmd.contains('\u{2014}'));
        // The same exe gets the same rule name regardless of case.
        assert_eq!(rule_name("C:\\A\\m.exe"), rule_name("c:\\a\\M.EXE"));
        assert_ne!(rule_name("C:\\A\\m.exe"), rule_name("C:\\B\\m.exe"));
    }

    #[test]
    fn scripts_embed_path_safely() {
        let path = r"C:\x\it's [1]\mira.exe";
        let script = status_script(path);
        assert!(script.contains(r"$p = 'C:\x\it''s [1]\mira.exe'"));
        assert!(script.contains(r"-Program 'C:\x\it''s `[1`]\mira.exe'"));
        assert!(script.contains("-PolicyStore ActiveStore"));
        assert!(
            !script.contains("New-") && !script.contains("Set-") && !script.contains("Remove-")
        );

        let request = request_script(Path::new(path));
        assert!(request.contains("-Verb RunAs"));
        assert!(request.contains("exit 1223"));
        // The elevated command travels base64-encoded, never as raw text.
        assert!(!request.contains("New-NetFirewallRule"));
        let inner = format!(
            "$ErrorActionPreference = 'Stop'\n{}\n",
            admin_command(Path::new(path))
        );
        assert!(request.contains(&encode_command(&inner)));
    }

    /// Runs the real, read-only status check on this machine:
    /// `cargo test -- --ignored firewall_status_live --nocapture`.
    #[test]
    #[ignore = "runs PowerShell against the real Windows Firewall (read only)"]
    fn firewall_status_live() {
        // MIRA_FIREWALL_PROBE=<exe path> checks another program instead.
        let exe = std::env::var_os("MIRA_FIREWALL_PROBE")
            .map(PathBuf::from)
            .unwrap_or_else(|| std::env::current_exe().unwrap());
        let started = std::time::Instant::now();
        let s = status(&exe);
        println!("{:#?}\n{:?}", s, started.elapsed());
        assert_ne!(s.rule, RuleState::Unknown, "{:?}", s.detail);
    }
}
