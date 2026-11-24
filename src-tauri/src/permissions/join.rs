//! Join requests (v0.3, docs/plans/v0.3-kontrak.md, "Protokol bergabung").
//!
//! A laptop that is not a member yet signs a `JoinRequestPayload` with its
//! own device key: organization, its key, the display name and department
//! it chose, and what it says about itself (laptop name, OS, Mira version).
//! The request is not an op (only members author ops). A superadmin or an
//! admin of the chosen department copies it verbatim into a `join_approve`
//! or `join_reject` op, so every laptop can check that the person really
//! asked, with that name, for that department.
//!
//! Every request names the organization's genesis fingerprint
//! ([`org_fingerprint`]), so it can only be approved in the organization
//! the requester saw (a rogue laptop copying the office's id and name has a
//! different genesis record).
//!
//! The matching code shown on both screens is Argon2id over the requester's
//! key and the request nonce, salted with the genesis fingerprint
//! ([`matching_code`]). It cannot be precomputed (it depends on the nonce
//! the requester picks) and each guess costs one Argon2id run, so another
//! laptop cannot find a request with the same code while an approver is
//! looking.
//!
//! v0.4 adds two optional fields (docs/plans/v04-onboarding.md, "Data
//! verifikasi"): `note`, a short text for the approver, and `account`, the
//! requester's operating system login name. They are written only when
//! present, so a request without them is byte-identical to v0.3. Mira v0.3
//! parses requests with `deny_unknown_fields` and refuses either field, so
//! the requester adds them only for offices whose members all answered
//! `join_info` with `extras >= 1`.
//!
//! The AD onboarding (docs/plans/onboarding-ad.md, 3.5) adds a third
//! optional field, `ad` ([`JoinAdClaim`]): the domain account the requester's
//! laptop is logged in with, as that laptop reports it. It follows the same
//! rules (absent when unused, never `null`) behind a stricter gate
//! ([`join_ad_allowed`], `extras >= 2`), since Mira v0.4.0 refuses it too.

use ed25519_dalek::{Signature, VerifyingKey};
use hex::FromHex;
use serde::{Deserialize, Serialize};
use time::{Duration, OffsetDateTime};

use super::format::{
    CROCKFORD, is_canonical_display_name, is_lower_hex, is_valid_app_version, is_valid_laptop_name,
    is_valid_os_name, parse_time,
};
use crate::org::Organization;

pub const JOIN_REQUEST_DOMAIN: &str = "mira-join-request-v1\n";
pub const JOIN_REQUEST_VERSION: u32 = 1;
/// Largest request payload in bytes.
pub const MAX_JOIN_REQUEST_BYTES: usize = 2048;
/// An approval must be dated at most this long after the request.
pub const JOIN_REQUEST_VALIDITY: Duration = Duration::days(7);
pub const JOIN_CODE_DOMAIN: &str = "mira-join-code-v1\n";
pub const ORG_FP_DOMAIN: &str = "mira-org-fp-v1\n";
/// Argon2id cost of the matching code: 8 MiB, 2 passes (tens of
/// milliseconds per request on a laptop, per guess for an attacker).
const CODE_M_COST_KIB: u32 = 8 * 1024;
const CODE_T_COST: u32 = 2;
/// Longest note for the approver, in characters (v0.4).
pub const JOIN_NOTE_MAX_CHARS: usize = 80;
/// Longest login account name, in characters (v0.4).
pub const JOIN_ACCOUNT_MAX_CHARS: usize = 64;

/// What the joining laptop signs. Field order is the serialization order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct JoinRequestPayload {
    pub v: u32,
    pub org: String,
    /// `org_fingerprint` of the genesis record the requester pinned.
    pub org_fp: String,
    /// The requester's device key (64 hex), also its TLS identity.
    pub member: String,
    pub name: String,
    /// Department chosen (team id, 32 hex).
    pub team: String,
    pub laptop: String,
    pub os: String,
    pub app_version: String,
    /// v0.4: what the requester tells the approver (job title, staff
    /// number). Absent in v0.3 requests. Never `null`: an explicit null is
    /// refused, so one request has one encoding (and one id).
    #[serde(
        default,
        deserialize_with = "present_string",
        skip_serializing_if = "Option::is_none"
    )]
    pub note: Option<String>,
    /// v0.4: the requester's login name on Windows (`USERNAME`) or macOS
    /// (`USER`). Absent or a string, never `null`.
    #[serde(
        default,
        deserialize_with = "present_string",
        skip_serializing_if = "Option::is_none"
    )]
    pub account: Option<String>,
    /// AD onboarding: the domain account the requester's laptop reports.
    /// Absent or an object, never `null`.
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub ad: Option<JoinAdClaim>,
    pub at: String,
    pub nonce: String,
}

impl JoinRequestPayload {
    /// Carries a field added after v0.3 (`note`, `account` or `ad`), so
    /// Mira v0.3 refuses it.
    pub fn has_extras(&self) -> bool {
        self.note.is_some() || self.account.is_some() || self.ad.is_some()
    }

    /// Carries the AD claim, so Mira v0.4.0 refuses it.
    pub fn has_ad(&self) -> bool {
        self.ad.is_some()
    }
}

/// The domain account a requester's laptop is logged in with, signed in the
/// request (docs/plans/onboarding-ad.md 3.5). Reported by the requester, so
/// it proves nothing by itself; the approver's laptop looks it up again.
/// Field order is the serialization order; optional fields are absent when
/// unknown, never `null`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct JoinAdClaim {
    /// Lowercase DNS domain, `macf.co.id` (`ad::dn::normalize_domain`).
    pub domain: String,
    /// `sAMAccountName`.
    pub user: String,
    /// Distinguished name; its `DC` parts must spell `domain`.
    #[serde(
        default,
        deserialize_with = "present_string",
        skip_serializing_if = "Option::is_none"
    )]
    pub dn: Option<String>,
    /// `displayName`.
    #[serde(
        default,
        deserialize_with = "present_string",
        skip_serializing_if = "Option::is_none"
    )]
    pub name: Option<String>,
    /// The `department` attribute.
    #[serde(
        default,
        deserialize_with = "present_string",
        skip_serializing_if = "Option::is_none"
    )]
    pub department: Option<String>,
}

/// What a requester adds to its request after v0.3. All optional; empty
/// means the request has the v0.3 shape.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct JoinExtras {
    pub note: Option<String>,
    pub account: Option<String>,
    /// AD onboarding: only for offices that answered `extras >= 2` and whose
    /// AD domain is the laptop's own.
    pub ad: Option<JoinAdClaim>,
}

impl JoinExtras {
    pub fn has_ad(&self) -> bool {
        self.ad.is_some()
    }
}

/// An optional field that, when present, must be a string (`null` is an
/// error). Used with `#[serde(default)]`, so an absent field is `None`.
fn present_string<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    String::deserialize(d).map(Some)
}

/// [`present_string`] for any value.
fn present<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(
    d: D,
) -> Result<Option<T>, D::Error> {
    T::deserialize(d).map(Some)
}

/// Characters a join note or account name may not contain: everything
/// `identity::has_forbidden_chars` refuses in names (controls, line and
/// paragraph separators, bidi marks and overrides, zero-width characters,
/// soft hyphen, BOM, interlinear annotations), plus characters that show
/// as blank or change nothing visible:
///
/// - U+115F, U+1160 Hangul choseong and jungseong fillers
/// - U+3164 Hangul filler, U+FFA0 halfwidth Hangul filler
/// - U+2800 Braille pattern blank
/// - U+034F combining grapheme joiner
/// - U+FE00..=U+FE0F variation selectors
/// - U+E0000..=U+E007F tag characters
///
/// The screen may mirror this list; [`is_combining_mark`] covers the other
/// rule (at most two combining marks in a row).
pub fn is_join_forbidden_char(c: char) -> bool {
    let mut buf = [0u8; 4];
    crate::identity::has_forbidden_chars(c.encode_utf8(&mut buf))
        || matches!(
            c,
            '\u{115F}'
                | '\u{1160}'
                | '\u{3164}'
                | '\u{FFA0}'
                | '\u{2800}'
                | '\u{034F}'
                | '\u{FE00}'..='\u{FE0F}'
                | '\u{E0000}'..='\u{E007F}'
        )
}

/// Most stacked combining marks allowed in a row in a note or account name.
pub const JOIN_MAX_COMBINING_RUN: usize = 2;

/// Combining marks, by block: U+0300..=U+036F, U+1AB0..=U+1AFF,
/// U+1DC0..=U+1DFF, U+20D0..=U+20FF, U+FE20..=U+FE2F. More than
/// [`JOIN_MAX_COMBINING_RUN`] in a row can pile text over the lines around
/// it.
pub fn is_combining_mark(c: char) -> bool {
    matches!(
        c,
        '\u{0300}'..='\u{036F}'
            | '\u{1AB0}'..='\u{1AFF}'
            | '\u{1DC0}'..='\u{1DFF}'
            | '\u{20D0}'..='\u{20FF}'
            | '\u{FE20}'..='\u{FE2F}'
    )
}

/// More than [`JOIN_MAX_COMBINING_RUN`] combining marks in a row.
pub fn has_long_mark_run(s: &str) -> bool {
    let mut run = 0;
    for c in s.chars() {
        run = if is_combining_mark(c) { run + 1 } else { 0 };
        if run > JOIN_MAX_COMBINING_RUN {
            return true;
        }
    }
    false
}

/// Drops the characters [`is_join_forbidden_char`] refuses and every
/// combining mark past the second in a row. Not trimmed.
pub fn strip_join_text(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut run = 0;
    for c in s.chars().filter(|c| !is_join_forbidden_char(*c)) {
        if is_combining_mark(c) {
            run += 1;
            if run > JOIN_MAX_COMBINING_RUN {
                continue;
            }
        } else {
            run = 0;
        }
        out.push(c);
    }
    out
}

/// Trimmed, 1 to `max` characters, none of [`is_join_forbidden_char`], at
/// most two combining marks in a row.
fn is_short_text(s: &str, max: usize) -> bool {
    s.trim() == s
        && (1..=max).contains(&s.chars().count())
        && !s.chars().any(is_join_forbidden_char)
        && !has_long_mark_run(s)
}

/// First Mira version that takes join requests with `note` and `account`.
///
/// A member only advertises and accepts such requests when every active
/// member of the organization (guests too: they receive the `join_approve`
/// op) last reported at least `min(own version, JOIN_EXTRAS_SINCE)` in its
/// device profile ([`join_extras_allowed`]). Mira v0.3 refuses both the
/// request and the `join_approve` op carrying it. The `min` keeps a dev
/// build still numbered below 0.4.0 usable among identical dev builds
/// (so the end-to-end tests exercise the fields); once this build is 0.4.0
/// or later, every laptop must be at least 0.4.0.
pub const JOIN_EXTRAS_SINCE: &str = "0.4.0";

/// `major.minor.patch` of a Mira version; a pre-release or build suffix
/// (`-beta.1`, `+abc`) is ignored. `None` when it does not have that form.
pub fn parse_app_version(s: &str) -> Option<(u32, u32, u32)> {
    let core = s.split(['-', '+']).next()?;
    let mut parts = core.split('.');
    let mut num = || -> Option<u32> {
        let p = parts.next()?;
        if p.is_empty() || !p.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        p.parse().ok()
    };
    let v = (num()?, num()?, num()?);
    parts.next().is_none().then_some(v)
}

/// The version every member must have reported for the extras gate.
fn extras_threshold() -> (u32, u32, u32) {
    let since = parse_app_version(JOIN_EXTRAS_SINCE).unwrap_or((0, 4, 0));
    parse_app_version(crate::device::APP_VERSION).map_or(since, |own| own.min(since))
}

/// Whether join requests with `note` or `account` may be advertised and
/// taken here: every active member (guests included) has a device profile
/// whose Mira version is at least the threshold of [`JOIN_EXTRAS_SINCE`].
/// A missing or unparseable version counts as too old. Not a fold rule:
/// it only decides what this laptop offers and stores.
pub fn join_extras_allowed(state: &super::fold::OrgState) -> bool {
    join_extras_allowed_since(state, extras_threshold())
}

pub(crate) fn join_extras_allowed_since(
    state: &super::fold::OrgState,
    threshold: (u32, u32, u32),
) -> bool {
    state
        .members
        .values()
        .filter(|m| m.status == super::fold::MemberStatus::Active)
        .all(|m| {
            m.device
                .as_ref()
                .and_then(|d| parse_app_version(&d.app_version))
                .is_some_and(|v| v >= threshold)
        })
}

/// A note as it may appear in a signed request.
pub fn is_valid_join_note(s: &str) -> bool {
    is_short_text(s, JOIN_NOTE_MAX_CHARS)
}

/// A login account name as it may appear in a signed request.
pub fn is_valid_join_account(s: &str) -> bool {
    is_short_text(s, JOIN_ACCOUNT_MAX_CHARS)
}

// ----- AD onboarding ---------------------------------------------------------

/// First Mira version that takes join requests with `ad` and the
/// `ad_settings_set` op (docs/plans/onboarding-ad.md 2). Same `min` rule as
/// [`JOIN_EXTRAS_SINCE`]: while this build is numbered below 0.5.0 the
/// threshold is this build's own version. The release that ships AD
/// onboarding must be numbered 0.5.0 or later (0.4.1 would also be safe:
/// the threshold would then be 0.4.1).
pub const JOIN_AD_SINCE: &str = "0.5.0";
/// Longest `sAMAccountName`, in characters.
pub const AD_USER_MAX_CHARS: usize = 64;
/// Longest `displayName` or `department` in a claim, in characters.
pub const AD_TEXT_MAX_CHARS: usize = 64;
/// Most rows in the OU to department mapping.
pub const AD_OU_MAP_MAX_ROWS: usize = 100;
/// Longest OU name in the mapping, in characters.
pub const AD_OU_MAX_CHARS: usize = 64;
/// Characters `sAMAccountName` may not contain (besides
/// [`is_join_forbidden_char`]).
const AD_USER_FORBIDDEN: &str = "\"/\\[]:;|=,+*?<>@";

/// The version every member must have reported for the AD gate.
pub fn join_ad_threshold() -> (u32, u32, u32) {
    let since = parse_app_version(JOIN_AD_SINCE).unwrap_or((0, 5, 0));
    parse_app_version(crate::device::APP_VERSION).map_or(since, |own| own.min(since))
}

/// Whether join requests with `ad` may be advertised (`extras: 2`) and
/// taken here: every active member, guests included, reported at least
/// [`join_ad_threshold`]. Not a fold rule.
pub fn join_ad_allowed(state: &super::fold::OrgState) -> bool {
    join_ad_allowed_since(state, join_ad_threshold())
}

pub fn join_ad_allowed_since(state: &super::fold::OrgState, threshold: (u32, u32, u32)) -> bool {
    join_extras_allowed_since(state, threshold)
}

/// Whether a superadmin may write `ad_settings_set` now: the same gate as
/// [`join_ad_allowed`], since every member must understand the op.
pub fn ad_settings_allowed(state: &super::fold::OrgState) -> bool {
    join_ad_allowed(state)
}

/// Whether a requester reporting `app_version` is older than the AD
/// threshold (an unparseable version counts as older).
pub fn is_below_ad_threshold(app_version: &str) -> bool {
    parse_app_version(app_version).is_none_or(|v| v < join_ad_threshold())
}

/// An active member whose laptop keeps the AD gate closed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdBlocker {
    pub member: String,
    pub name: String,
    /// Last reported Mira version; `None` when never reported.
    pub app_version: Option<String>,
}

/// Active members (guests included) below [`join_ad_threshold`], by name.
pub fn ad_blockers(state: &super::fold::OrgState) -> Vec<AdBlocker> {
    ad_blockers_since(state, join_ad_threshold())
}

pub fn ad_blockers_since(
    state: &super::fold::OrgState,
    threshold: (u32, u32, u32),
) -> Vec<AdBlocker> {
    let mut out: Vec<AdBlocker> = state
        .members
        .values()
        .filter(|m| m.status == super::fold::MemberStatus::Active)
        .filter(|m| {
            !m.device
                .as_ref()
                .and_then(|d| parse_app_version(&d.app_version))
                .is_some_and(|v| v >= threshold)
        })
        .map(|m| AdBlocker {
            member: m.public_key.clone(),
            name: super::store::display_name_for(state, &m.public_key, None),
            app_version: m.device.as_ref().map(|d| d.app_version.clone()),
        })
        .collect();
    out.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then_with(|| a.member.cmp(&b.member))
    });
    out
}

/// A DNS domain as stored: already `normalize_domain`d.
pub fn is_valid_ad_domain(s: &str) -> bool {
    crate::ad::dn::normalize_domain(s).as_deref() == Some(s)
}

/// A `sAMAccountName`: 1 to 64 characters, no leading or trailing space,
/// none of `"/\[]:;|=,+*?<>@` or [`is_join_forbidden_char`].
pub fn is_valid_ad_user(s: &str) -> bool {
    is_short_text(s, AD_USER_MAX_CHARS) && !s.chars().any(|c| AD_USER_FORBIDDEN.contains(c))
}

/// A distinguished name in `domain`: at most `MAX_DN_CHARS` characters,
/// none of [`is_join_forbidden_char`], parses, and its `DC` parts spell
/// `domain`.
pub fn is_valid_ad_dn(dn: &str, domain: &str) -> bool {
    dn.chars().count() <= crate::ad::dn::MAX_DN_CHARS
        && !dn.chars().any(is_join_forbidden_char)
        && crate::ad::dn::parse_dn(dn).is_some()
        && crate::ad::dn::domain_of(dn).as_deref() == Some(domain)
}

/// A `displayName` or `department` value in a claim.
pub fn is_valid_ad_text(s: &str) -> bool {
    is_short_text(s, AD_TEXT_MAX_CHARS)
}

/// An OU name in the mapping (1 to 64 characters, like a note).
pub fn is_valid_ou_name(s: &str) -> bool {
    is_short_text(s, AD_OU_MAX_CHARS)
}

/// Every field of a claim. The error names the field (Indonesian, for
/// logs and the "cannot create" message).
pub fn check_ad_claim(c: &JoinAdClaim) -> Result<(), String> {
    need(is_valid_ad_domain(&c.domain), "domain AD tidak valid")?;
    need(is_valid_ad_user(&c.user), "nama akun AD tidak valid")?;
    need(
        c.dn.as_deref().is_none_or(|dn| is_valid_ad_dn(dn, &c.domain)),
        "DN akun AD tidak valid",
    )?;
    need(
        c.name.as_deref().is_none_or(is_valid_ad_text),
        "nama di AD tidak valid",
    )?;
    need(
        c.department.as_deref().is_none_or(is_valid_ad_text),
        "departemen di AD tidak valid",
    )
}

/// Format of an OU mapping (also checked in the `ad_settings_set` op): at
/// most [`AD_OU_MAP_MAX_ROWS`] rows, each OU [`is_valid_ou_name`] and
/// unique ignoring case, each team 32 lowercase hex.
pub fn check_ou_map(map: &[crate::ad::OuMapping]) -> Result<(), String> {
    need(
        map.len() <= AD_OU_MAP_MAX_ROWS,
        "pemetaan OU lebih dari 100 baris",
    )?;
    let mut seen = std::collections::HashSet::new();
    for row in map {
        need(is_valid_ou_name(&row.ou), "nama OU tidak valid")?;
        need(is_lower_hex(&row.team, 32), "departemen pemetaan OU tidak valid")?;
        need(
            row.division.as_deref().is_none_or(|d| is_lower_hex(d, 32)),
            "divisi pemetaan OU tidak valid",
        )?;
        need(seen.insert(row.ou.to_lowercase()), "nama OU ganda")?;
    }
    Ok(())
}

/// Makes the request fit [`MAX_JOIN_REQUEST_BYTES`] by dropping the AD
/// claim's `dn`, then the whole claim. Mira v0.4.0 applies that limit to
/// the requests inside `join_approve` ops, so it is not raised. Every
/// field outside the claim fits on its own.
pub fn fit_ad_claim(p: &mut JoinRequestPayload) {
    let size = |p: &JoinRequestPayload| serde_json::to_string(p).map_or(usize::MAX, |s| s.len());
    if p.ad.is_none() || size(p) <= MAX_JOIN_REQUEST_BYTES {
        return;
    }
    if let Some(ad) = p.ad.as_mut() {
        ad.dn = None;
    }
    if size(p) > MAX_JOIN_REQUEST_BYTES {
        p.ad = None;
    }
}

/// A request as stored and sent: the exact payload string and the
/// requester's Ed25519 signature over `JOIN_REQUEST_DOMAIN + payload`.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SignedJoinRequest {
    pub payload: String,
    pub sig: String,
}

impl SignedJoinRequest {
    /// Request id: `hex(blake3(payload))`.
    pub fn id(&self) -> String {
        request_id(&self.payload)
    }
}

pub fn request_id(payload: &str) -> String {
    blake3::hash(payload.as_bytes()).to_hex().to_string()
}

/// A request whose format, organization and signature were checked.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedJoinRequest {
    pub id: String,
    pub signed: SignedJoinRequest,
    pub payload: JoinRequestPayload,
    pub at: OffsetDateTime,
}

pub fn join_request_message(payload: &str) -> Vec<u8> {
    let mut msg = Vec::with_capacity(JOIN_REQUEST_DOMAIN.len() + payload.len());
    msg.extend_from_slice(JOIN_REQUEST_DOMAIN.as_bytes());
    msg.extend_from_slice(payload.as_bytes());
    msg
}

fn need(ok: bool, what: &str) -> Result<(), String> {
    if ok { Ok(()) } else { Err(what.to_owned()) }
}

/// Parses and checks every field of a request payload (no signature).
pub fn parse_request_payload(s: &str) -> Result<JoinRequestPayload, String> {
    need(
        s.len() <= MAX_JOIN_REQUEST_BYTES,
        "permintaan bergabung terlalu besar",
    )?;
    let p: JoinRequestPayload = serde_json::from_str(s).map_err(|e| {
        let mut msg = format!("permintaan bergabung bukan JSON yang dikenal: {e}");
        msg.truncate(300);
        msg
    })?;
    need(
        p.v == JOIN_REQUEST_VERSION,
        "versi permintaan bergabung tidak dikenal",
    )?;
    need(is_lower_hex(&p.org, 32), "org permintaan tidak valid")?;
    need(
        is_lower_hex(&p.org_fp, 64),
        "sidik organisasi permintaan tidak valid",
    )?;
    need(
        is_lower_hex(&p.member, 64) && super::op::is_point(&p.member),
        "kunci peminta tidak valid",
    )?;
    need(
        is_canonical_display_name(&p.name),
        "nama peminta tidak valid",
    )?;
    need(
        is_lower_hex(&p.team, 32),
        "departemen permintaan tidak valid",
    )?;
    need(is_valid_laptop_name(&p.laptop), "nama laptop tidak valid")?;
    need(is_valid_os_name(&p.os), "nama sistem operasi tidak valid")?;
    need(
        is_valid_app_version(&p.app_version),
        "versi Mira tidak valid",
    )?;
    need(
        p.note.as_deref().is_none_or(is_valid_join_note),
        "keterangan permintaan tidak valid",
    )?;
    need(
        p.account.as_deref().is_none_or(is_valid_join_account),
        "nama akun peminta tidak valid",
    )?;
    if let Some(ad) = &p.ad {
        check_ad_claim(ad)?;
    }
    need(parse_time(&p.at).is_some(), "waktu permintaan tidak valid")?;
    need(is_lower_hex(&p.nonce, 32), "nonce permintaan tidak valid")?;
    Ok(p)
}

fn verify_sig(public_key: &str, message: &[u8], sig: &str) -> bool {
    let (Ok(pk), Ok(sig)) = (<[u8; 32]>::from_hex(public_key), <[u8; 64]>::from_hex(sig)) else {
        return false;
    };
    VerifyingKey::from_bytes(&pk).is_ok_and(|k| {
        k.verify_strict(message, &Signature::from_bytes(&sig))
            .is_ok()
    })
}

/// Full check: format, organization `org` (id and genesis fingerprint) and
/// the requester's signature.
pub fn verify_join_request(
    signed: &SignedJoinRequest,
    org: &Organization,
) -> Result<VerifiedJoinRequest, String> {
    need(
        is_lower_hex(&signed.sig, 128),
        "tanda tangan permintaan harus 128 karakter hex",
    )?;
    let payload = parse_request_payload(&signed.payload)?;
    need(payload.org == org.id, "permintaan untuk organisasi lain")?;
    need(
        payload.org_fp == org_fingerprint(org),
        "permintaan untuk organisasi lain dengan id yang sama",
    )?;
    need(
        verify_sig(
            &payload.member,
            &join_request_message(&signed.payload),
            &signed.sig,
        ),
        "tanda tangan permintaan tidak cocok dengan kunci peminta",
    )?;
    let at = parse_time(&payload.at).ok_or("waktu permintaan tidak valid")?;
    Ok(VerifiedJoinRequest {
        id: signed.id(),
        signed: signed.clone(),
        payload,
        at,
    })
}

/// Serializes and signs a request with the given signer.
pub fn sign_join_request(
    payload: &JoinRequestPayload,
    sign: impl FnOnce(&[u8]) -> Signature,
) -> SignedJoinRequest {
    let payload = serde_json::to_string(payload).expect("join request always serializes");
    let sig = sign(&join_request_message(&payload));
    SignedJoinRequest {
        payload,
        sig: hex::encode(sig.to_bytes()),
    }
}

/// Fingerprint of an organization's genesis record (64 hex): BLAKE3 of
/// `"mira-org-fp-v1\n"` and every field of the record, one per line. Two
/// organizations with the same id but different founders differ here.
pub fn org_fingerprint(org: &Organization) -> String {
    let input = format!(
        "{ORG_FP_DOMAIN}{}\n{}\n{}\n{}\n{}",
        org.id, org.name, org.founder_public_key, org.created_at, org.genesis_signature
    );
    blake3::hash(input.as_bytes()).to_hex().to_string()
}

/// 40 bits as 8 Crockford base32 characters.
fn crockford40(bytes: &[u8]) -> String {
    let mut bits: u64 = 0;
    for b in &bytes[..5] {
        bits = (bits << 8) | u64::from(*b);
    }
    (0..8)
        .rev()
        .map(|i| CROCKFORD[((bits >> (i * 5)) & 31) as usize] as char)
        .collect()
}

/// Short organization fingerprint for people to compare, `XXXX-XXXX`.
pub fn org_fingerprint_short(org: &Organization) -> String {
    let fp = org_fingerprint(org);
    let bytes = hex::decode(&fp[..10]).unwrap_or_default();
    let chars = crockford40(&bytes);
    format!("{}-{}", &chars[..4], &chars[4..])
}

/// Matching code of a request, `XXXX XXXX`: the first 40 bits of
/// Argon2id(password = member + "\n" + nonce, salt = first 16 bytes of
/// BLAKE3(`"mira-join-code-v1\n"` + org_fp), 8 MiB, 2 passes), in Crockford
/// base32.
pub fn matching_code(org_fp: &str, member: &str, nonce: &str) -> String {
    use argon2::{Algorithm, Argon2, Params, Version};
    let salt_hash = blake3::hash(format!("{JOIN_CODE_DOMAIN}{org_fp}").as_bytes());
    let salt = &salt_hash.as_bytes()[..16];
    let password = format!("{member}\n{nonce}");
    let mut out = [0u8; 8];
    let ok = Params::new(CODE_M_COST_KIB, CODE_T_COST, 1, Some(out.len()))
        .map(|p| Argon2::new(Algorithm::Argon2id, Version::V0x13, p))
        .ok()
        .and_then(|a| {
            a.hash_password_into(password.as_bytes(), salt, &mut out)
                .ok()
        })
        .is_some();
    if !ok {
        // Only reachable with broken constants; fall back to a plain hash.
        let h = blake3::hash(format!("{JOIN_CODE_DOMAIN}{org_fp}\n{password}").as_bytes());
        out.copy_from_slice(&h.as_bytes()[..8]);
    }
    let chars = crockford40(&out);
    format!("{} {}", &chars[..4], &chars[4..])
}

/// Matching code of a parsed request.
pub fn request_code(p: &JoinRequestPayload) -> String {
    matching_code(&p.org_fp, &p.member, &p.nonce)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use rand_core::OsRng;

    fn org() -> Organization {
        Organization {
            id: "0123456789abcdef0123456789abcdef".into(),
            name: "Biro Contoh".into(),
            founder_public_key: "11".repeat(32),
            created_at: "2026-11-01T00:00:00Z".into(),
            genesis_signature: "22".repeat(64),
        }
    }

    fn payload(member: &str) -> JoinRequestPayload {
        JoinRequestPayload {
            v: 1,
            org: org().id,
            org_fp: org_fingerprint(&org()),
            member: member.into(),
            name: "Rina".into(),
            team: "ab".repeat(16),
            laptop: "LAPTOP-DESAIN-03".into(),
            os: "Windows 11".into(),
            app_version: "0.3.0".into(),
            note: None,
            account: None,
            ad: None,
            at: "2026-11-23T08:00:00Z".into(),
            nonce: "cd".repeat(16),
        }
    }

    /// A request as Mira v0.3 writes it, byte for byte.
    const V03_PAYLOAD: &str = concat!(
        "{\"v\":1,\"org\":\"0123456789abcdef0123456789abcdef\",",
        "\"org_fp\":\"ORGFP\",\"member\":\"MEMBER\",\"name\":\"Rina\",",
        "\"team\":\"abababababababababababababababab\",\"laptop\":\"LAPTOP-DESAIN-03\",",
        "\"os\":\"Windows 11\",\"app_version\":\"0.3.0\",\"at\":\"2026-11-23T08:00:00Z\",",
        "\"nonce\":\"cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd\"}"
    );

    #[test]
    fn v03_payload_parses_and_serializes_byte_identically() {
        let sk = SigningKey::generate(&mut OsRng);
        let pk = hex::encode(sk.verifying_key().as_bytes());
        let v03 = V03_PAYLOAD
            .replace("ORGFP", &org_fingerprint(&org()))
            .replace("MEMBER", &pk);
        let p = parse_request_payload(&v03).unwrap();
        assert_eq!(p, payload(&pk));
        assert_eq!(p.note, None);
        assert_eq!(p.account, None);
        assert_eq!(serde_json::to_string(&p).unwrap(), v03);
        // A payload without extras signs exactly like v0.3.
        let signed = sign_join_request(&payload(&pk), |m| sk.sign(m));
        assert_eq!(signed.payload, v03);
    }

    #[test]
    fn note_and_account_are_signed_after_app_version() {
        let sk = SigningKey::generate(&mut OsRng);
        let pk = hex::encode(sk.verifying_key().as_bytes());
        let p = JoinRequestPayload {
            note: Some("Staf gudang, NIK 1234".into()),
            account: Some("rina.w".into()),
            ..payload(&pk)
        };
        let signed = sign_join_request(&p, |m| sk.sign(m));
        assert!(signed.payload.contains(
            "\"app_version\":\"0.3.0\",\"note\":\"Staf gudang, NIK 1234\",\"account\":\"rina.w\",\"at\""
        ));
        let v = verify_join_request(&signed, &org()).unwrap();
        assert_eq!(v.payload, p);
        // Only one of them is fine too.
        let only_note = JoinRequestPayload {
            account: None,
            ..p.clone()
        };
        let s = serde_json::to_string(&only_note).unwrap();
        assert!(!s.contains("account"));
        assert_eq!(parse_request_payload(&s).unwrap(), only_note);
    }

    #[test]
    fn invalid_note_or_account_is_rejected() {
        let pk = hex::encode(SigningKey::generate(&mut OsRng).verifying_key().as_bytes());
        let with = |note: Option<&str>, account: Option<&str>| {
            serde_json::to_string(&JoinRequestPayload {
                note: note.map(str::to_owned),
                account: account.map(str::to_owned),
                ..payload(&pk)
            })
            .unwrap()
        };
        assert!(parse_request_payload(&with(Some(&"é".repeat(JOIN_NOTE_MAX_CHARS)), None)).is_ok());
        assert!(
            parse_request_payload(&with(None, Some(&"x".repeat(JOIN_ACCOUNT_MAX_CHARS)))).is_ok()
        );
        for note in [
            "",
            " Staf",
            "Staf ",
            "Staf\ngudang",
            "Staf\tgudang",
            "Staf\u{202E}gudang",
            "Staf\u{200B}",
            &"x".repeat(JOIN_NOTE_MAX_CHARS + 1),
        ] {
            assert!(
                parse_request_payload(&with(Some(note), None)).is_err(),
                "{note:?}"
            );
        }
        for account in [
            "",
            " rina",
            "rina\u{0000}",
            "ri\u{2066}na",
            &"x".repeat(JOIN_ACCOUNT_MAX_CHARS + 1),
        ] {
            assert!(
                parse_request_payload(&with(None, Some(account))).is_err(),
                "{account:?}"
            );
        }
        // Wrong types are not extras either.
        let ok = with(None, None);
        let num = ok.replace("\"at\"", "\"note\":5,\"at\"");
        assert!(parse_request_payload(&num).is_err());
    }

    #[test]
    fn largest_request_fits_the_byte_limit() {
        let pk = hex::encode(SigningKey::generate(&mut OsRng).verifying_key().as_bytes());
        // Four-byte characters are the worst case: JSON keeps them as is,
        // and control characters (escaped as \uXXXX) are not allowed.
        for wide in ["é", "\u{1F600}"] {
            let p = JoinRequestPayload {
                name: wide.repeat(crate::identity::DISPLAY_NAME_MAX_CHARS),
                laptop: wide.repeat(super::super::format::LAPTOP_NAME_MAX_CHARS),
                os: wide.repeat(super::super::format::OS_NAME_MAX_CHARS),
                app_version: "1".repeat(super::super::format::APP_VERSION_MAX_CHARS),
                note: Some(wide.repeat(JOIN_NOTE_MAX_CHARS)),
                account: Some(wide.repeat(JOIN_ACCOUNT_MAX_CHARS)),
                at: "2026-11-23T08:00:00.123456789+07:00".into(),
                ..payload(&pk)
            };
            let s = serde_json::to_string(&p).unwrap();
            assert!(
                s.len() <= MAX_JOIN_REQUEST_BYTES,
                "{wide}: {} bytes",
                s.len()
            );
            assert_eq!(parse_request_payload(&s).unwrap(), p);
        }
    }

    #[test]
    fn signed_request_round_trip_and_tamper() {
        let sk = SigningKey::generate(&mut OsRng);
        let pk = hex::encode(sk.verifying_key().as_bytes());
        let p = payload(&pk);
        let signed = sign_join_request(&p, |m| sk.sign(m));
        let v = verify_join_request(&signed, &org()).unwrap();
        assert_eq!(v.payload, p);
        assert_eq!(v.id, request_id(&signed.payload));
        let other_id = Organization {
            id: "00".repeat(16),
            ..org()
        };
        assert!(verify_join_request(&signed, &other_id).is_err());
        // Same id and name, another founder: a copy of the office.
        let copy = Organization {
            founder_public_key: "33".repeat(32),
            ..org()
        };
        assert!(verify_join_request(&signed, &copy).is_err());
        let mut bad = signed.clone();
        bad.payload = bad.payload.replace("Rina", "Rino");
        assert!(verify_join_request(&bad, &org()).is_err());
        // Signed by another key than the one named in the request.
        let other = SigningKey::generate(&mut OsRng);
        let forged = sign_join_request(&p, |m| other.sign(m));
        assert!(verify_join_request(&forged, &org()).is_err());
    }

    #[test]
    fn payload_fields_are_checked() {
        let sk = SigningKey::generate(&mut OsRng);
        let pk = hex::encode(sk.verifying_key().as_bytes());
        let ok = serde_json::to_string(&payload(&pk)).unwrap();
        assert!(parse_request_payload(&ok).is_ok());
        for (from, to) in [
            ("\"v\":1", "\"v\":2"),
            ("\"name\":\"Rina\"", "\"name\":\" Rina\""),
            ("\"os\":\"Windows 11\"", "\"os\":\"\""),
            ("\"app_version\":\"0.3.0\"", "\"app_version\":\"0 3\""),
            ("\"at\":\"2026-11-23T08:00:00Z\"", "\"at\":\"kemarin\""),
        ] {
            let bad = ok.replace(from, to);
            assert_ne!(bad, ok, "{from}");
            assert!(parse_request_payload(&bad).is_err(), "{from}");
        }
        let extra = ok.replace("\"v\":1", "\"v\":1,\"extra\":1");
        assert!(parse_request_payload(&extra).is_err());
        assert!(parse_request_payload(&"x".repeat(MAX_JOIN_REQUEST_BYTES + 1)).is_err());
    }

    #[test]
    fn matching_code_is_stable_and_bound_to_org_key_and_nonce() {
        let fp = org_fingerprint(&org());
        let (k, n) = ("11".repeat(32), "aa".repeat(16));
        let a = matching_code(&fp, &k, &n);
        assert_eq!(a, matching_code(&fp, &k, &n));
        assert_eq!(a.len(), 9);
        assert_eq!(&a[4..5], " ");
        assert!(a.replace(' ', "").bytes().all(|b| CROCKFORD.contains(&b)));
        assert_ne!(a, matching_code(&fp, &"12".repeat(32), &n));
        assert_ne!(a, matching_code(&fp, &k, &"ab".repeat(16)));
        assert_ne!(a, matching_code(&"ff".repeat(32), &k, &n));
    }

    #[test]
    fn org_fingerprint_covers_the_whole_genesis_record() {
        let a = org_fingerprint(&org());
        assert_eq!(a.len(), 64);
        for changed in [
            Organization {
                name: "Biro Lain".into(),
                ..org()
            },
            Organization {
                founder_public_key: "33".repeat(32),
                ..org()
            },
            Organization {
                created_at: "2026-11-02T00:00:00Z".into(),
                ..org()
            },
            Organization {
                genesis_signature: "44".repeat(64),
                ..org()
            },
        ] {
            assert_ne!(org_fingerprint(&changed), a);
        }
        let short = org_fingerprint_short(&org());
        assert_eq!(short.len(), 9);
        assert_eq!(&short[4..5], "-");
    }

    #[test]
    fn explicit_null_extras_are_refused() {
        let pk = hex::encode(SigningKey::generate(&mut OsRng).verifying_key().as_bytes());
        let ok = serde_json::to_string(&payload(&pk)).unwrap();
        for field in ["note", "account"] {
            let null = ok.replace("\"at\"", &format!("\"{field}\":null,\"at\""));
            assert!(parse_request_payload(&null).is_err(), "{field}");
            let set = ok.replace("\"at\"", &format!("\"{field}\":\"x\",\"at\""));
            assert!(parse_request_payload(&set).is_ok(), "{field}");
        }
    }

    #[test]
    fn invisible_and_stacked_characters_are_refused() {
        for c in [
            '\u{115F}',
            '\u{1160}',
            '\u{3164}',
            '\u{FFA0}',
            '\u{2800}',
            '\u{034F}',
            '\u{FE00}',
            '\u{FE0F}',
            '\u{E0000}',
            '\u{E0041}',
            '\u{E007F}',
            // Already refused for names: bidi, zero-width, controls.
            '\u{202E}',
            '\u{200B}',
            '\u{0007}',
        ] {
            assert!(is_join_forbidden_char(c), "{:04X}", c as u32);
            let s = format!("Staf{c}gudang");
            assert!(!is_valid_join_note(&s), "{:04X}", c as u32);
            assert!(!is_valid_join_account(&s), "{:04X}", c as u32);
        }
        for c in ['a', 'é', 'ß', '\u{0301}', ' ', '-', '.'] {
            assert!(!is_join_forbidden_char(c), "{c}");
        }
        // Up to two combining marks in a row are fine (Vietnamese "ệ" as
        // e + two marks), three are not.
        assert!(is_valid_join_note("Nguye\u{0302}\u{0323}n"));
        assert!(!is_valid_join_note("Nguye\u{0302}\u{0323}\u{0301}n"));
        for mark in ['\u{0300}', '\u{1AB0}', '\u{1DC0}', '\u{20D0}', '\u{FE20}'] {
            assert!(is_combining_mark(mark), "{:04X}", mark as u32);
            let three = format!("a{mark}{mark}{mark}");
            assert!(!is_valid_join_account(&three), "{:04X}", mark as u32);
        }
        assert!(!is_combining_mark('a'));
    }

    #[test]
    fn stripping_leaves_valid_text() {
        assert_eq!(strip_join_text("ri\u{3164}na\u{FE0F}.w"), "rina.w");
        assert_eq!(
            strip_join_text("a\u{0301}\u{0301}\u{0301}\u{0301}b"),
            "a\u{0301}\u{0301}b"
        );
        // A removed character does not join two runs of marks into one.
        assert_eq!(
            strip_join_text("a\u{0301}\u{0301}\u{200B}\u{0301}b"),
            "a\u{0301}\u{0301}b"
        );
        assert_eq!(strip_join_text("\u{E0041}\u{2800}"), "");
    }

    #[test]
    fn app_versions_compare_by_major_minor_patch() {
        let v = parse_app_version;
        assert_eq!(v("0.4.0"), Some((0, 4, 0)));
        assert_eq!(v("1.10.2"), Some((1, 10, 2)));
        assert_eq!(v("0.4.0-beta.1+abc"), Some((0, 4, 0)));
        for bad in ["", "0.4", "0.4.0.1", "v0.4.0", "0.x.0", "0.4.0 ", "-1.0.0"] {
            assert_eq!(v(bad), None, "{bad:?}");
        }
        assert!(v("0.10.0") > v("0.4.0"));
        assert!(v("0.3.9") < v("0.4.0"));
        // The threshold is never above the version being built.
        let own = parse_app_version(crate::device::APP_VERSION).unwrap();
        let since = parse_app_version(JOIN_EXTRAS_SINCE).unwrap();
        assert_eq!(extras_threshold(), own.min(since));
    }
}
