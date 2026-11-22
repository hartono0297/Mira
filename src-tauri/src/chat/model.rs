//! Chat record format: signed payloads, conversation ids and field checks
//! (docs/plans/tahap-2.md, sections 2 and 3). Pure: no database, no clock.
//!
//! A record body is `{"payload":"<JSON string>","sig":"<128 hex>"}`. The
//! signature is Ed25519 over `CHAT_DOMAIN + payload` with the author's laptop
//! key. The record id is BLAKE3 of the whole body (network contract).

use ed25519_dalek::Signature;
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;

use crate::identity::{Identity, verify_hex};
use crate::network::feature::{FeatureRecord, MAX_RECORD_BYTES};
use crate::permissions::format::{format_time, is_lower_hex, parse_time};

/// Domain prefix of the signed message.
pub const CHAT_DOMAIN: &str = "mira-chat-v1\n";
pub const CHAT_VERSION: u32 = 1;

pub const MAX_TEXT_CHARS: usize = 8000;
pub const MAX_CHANNEL_NAME_CHARS: usize = 40;
pub const MAX_FILE_NAME_CHARS: usize = 200;
pub const MAX_MIME_CHARS: usize = 100;
pub const MAX_FILES: usize = 10;
pub const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// Largest encrypted attachment in an envelope: only small files travel with
/// envelopes (`blobs::AUTO_REPLICATE_MAX_BYTES` plus nonce and tag).
pub const MAX_CIPHER_FILE_BYTES: u64 = crate::blobs::AUTO_REPLICATE_MAX_BYTES + 40;
pub const MAX_MENTIONS: usize = 50;
pub const MAX_RECEIPT_MESSAGES: usize = 500;
/// Envelope `sealed` field, base64 characters. Leaves room for the payload
/// around it within `MAX_RECORD_BYTES`.
pub const MAX_SEALED_CHARS: usize = 200 * 1024;
/// Records dated further ahead of the receiver's clock are refused for now
/// (and offered again later), same rule as membership ops.
pub const MAX_CLOCK_AHEAD: time::Duration = time::Duration::minutes(10);
/// Accepted years for `at`.
const MIN_YEAR: i32 = 2020;
const MAX_YEAR: i32 = 2100;

/// Who a channel is for.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ChannelScope {
    /// Every active member who is not a guest.
    Org,
    /// Members of one team.
    Team { id: String },
    /// Members of one board project (and its guests).
    Project { id: String },
}

/// One file attached to a message. `hash` is the BLAKE3 of the file bytes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FileRef {
    pub hash: String,
    pub size: u64,
    pub name: String,
    pub mime: String,
}

/// Encrypted copy of an attachment that travels with envelopes: BLAKE3 and
/// size of the cipher file (`nonce || ciphertext`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CipherFileRef {
    pub hash: String,
    pub size: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReceiptState {
    Delivered,
    Read,
}

impl ReceiptState {
    pub fn as_str(self) -> &'static str {
        match self {
            ReceiptState::Delivered => "delivered",
            ReceiptState::Read => "read",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "delivered" => Some(ReceiptState::Delivered),
            "read" => Some(ReceiptState::Read),
            _ => None,
        }
    }
}

/// What a record says. See the table in the plan, section 2.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Body {
    ChannelCreate {
        channel: String,
        name: String,
        scope: ChannelScope,
    },
    ChannelArchive {
        conv: String,
        archived: bool,
    },
    ChannelDelete {
        conv: String,
    },
    Message {
        conv: String,
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reply_to: Option<String>,
        #[serde(default)]
        mentions: Vec<String>,
        #[serde(default)]
        files: Vec<FileRef>,
    },
    MessageDelete {
        conv: String,
        message: String,
        message_author: String,
        message_at: String,
    },
    Receipt {
        conv: String,
        state: ReceiptState,
        messages: Vec<String>,
    },
    Envelope {
        to: String,
        sealed: String,
        #[serde(default)]
        cipher_files: Vec<CipherFileRef>,
    },
    EnvelopeAck {
        envelope: String,
    },
}

impl Body {
    pub fn kind(&self) -> &'static str {
        match self {
            Body::ChannelCreate { .. } => "channel_create",
            Body::ChannelArchive { .. } => "channel_archive",
            Body::ChannelDelete { .. } => "channel_delete",
            Body::Message { .. } => "message",
            Body::MessageDelete { .. } => "message_delete",
            Body::Receipt { .. } => "receipt",
            Body::Envelope { .. } => "envelope",
            Body::EnvelopeAck { .. } => "envelope_ack",
        }
    }

    /// The conversation the record belongs to; `None` for envelopes and
    /// their acks, which are not part of any conversation.
    pub fn conv(&self) -> Option<String> {
        match self {
            Body::ChannelCreate { channel, .. } => Some(channel_conv(channel)),
            Body::ChannelArchive { conv, .. }
            | Body::ChannelDelete { conv }
            | Body::Message { conv, .. }
            | Body::MessageDelete { conv, .. }
            | Body::Receipt { conv, .. } => Some(conv.clone()),
            Body::Envelope { .. } | Body::EnvelopeAck { .. } => None,
        }
    }

    /// Sort rank so a batch applies in dependency order: channels first,
    /// then content, then the records that point at content.
    pub fn apply_rank(&self) -> u8 {
        match self {
            Body::ChannelCreate { .. } => 0,
            Body::ChannelArchive { .. } | Body::ChannelDelete { .. } => 1,
            Body::Message { .. } => 2,
            Body::MessageDelete { .. } | Body::Receipt { .. } => 3,
            Body::Envelope { .. } => 4,
            Body::EnvelopeAck { .. } => 5,
        }
    }
}

/// The signed part of a record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Payload {
    pub v: u32,
    pub org: String,
    pub author: String,
    pub at: String,
    /// 32 hex of randomness so two identical records made in the same
    /// second still get different ids.
    pub nonce: String,
    pub body: Body,
}

/// Record body as stored and sent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SignedRecord {
    pub payload: String,
    pub sig: String,
}

/// A record whose format and signature were checked.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedRecord {
    /// BLAKE3 of the body, 64 hex.
    pub id: String,
    /// The exact body string (what goes into `FeatureRecord::body`).
    pub body_json: String,
    pub payload: Payload,
    pub at: OffsetDateTime,
}

impl VerifiedRecord {
    pub fn to_feature_record(&self) -> FeatureRecord {
        FeatureRecord {
            id: self.id.clone(),
            body: self.body_json.clone(),
        }
    }

    pub fn author(&self) -> &str {
        &self.payload.author
    }

    pub fn body(&self) -> &Body {
        &self.payload.body
    }
}

/// Why a record was refused. `code` goes to `rejected_changes` as `chat_<code>`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rejection {
    pub code: &'static str,
    pub detail: String,
}

impl Rejection {
    pub fn new(code: &'static str, detail: impl Into<String>) -> Self {
        let mut detail = detail.into();
        if detail.len() > 300 {
            let mut cut = 300;
            while !detail.is_char_boundary(cut) {
                cut -= 1;
            }
            detail.truncate(cut);
        }
        Self { code, detail }
    }
}

/// 32 random hex characters (16 bytes), for channel ids and nonces.
pub fn random_hex32() -> String {
    let mut b = [0u8; 16];
    OsRng.fill_bytes(&mut b);
    hex::encode(b)
}

/// Channel id of a `channel_create`: first 32 hex of
/// `blake3("mira-chat-channel-v1\n" + org + "\n" + author + "\n" + nonce)`.
/// Derived, not chosen, so nobody can create a channel whose id collides with
/// `#umum`, a team channel, a project channel or another member's channel.
pub fn derive_channel_id(org: &str, author: &str, nonce: &str) -> String {
    let hash =
        blake3::hash(format!("mira-chat-channel-v1\n{org}\n{author}\n{nonce}").as_bytes());
    hash.to_hex()[..32].to_owned()
}

/// Signs `body` as `identity` for organization `org` at `at`. For
/// `channel_create` the `channel` field is replaced by
/// [`derive_channel_id`]; pass any value.
pub fn sign_record(identity: &Identity, org: &str, at: OffsetDateTime, body: Body) -> VerifiedRecord {
    let author = identity.public_key_hex().to_owned();
    let nonce = random_hex32();
    let body = match body {
        Body::ChannelCreate { name, scope, .. } => Body::ChannelCreate {
            channel: derive_channel_id(org, &author, &nonce),
            name,
            scope,
        },
        other => other,
    };
    let payload = Payload {
        v: CHAT_VERSION,
        org: org.to_owned(),
        author,
        at: format_time(at),
        nonce,
        body,
    };
    let payload_json = serde_json::to_string(&payload).expect("chat payload always serializes");
    let sig: Signature = identity.sign(signed_message(&payload_json).as_bytes());
    let signed = SignedRecord {
        payload: payload_json,
        sig: hex::encode(sig.to_bytes()),
    };
    let body_json = serde_json::to_string(&signed).expect("signed record always serializes");
    let id = crate::network::feature::record_id(&body_json);
    let at = parse_time(&payload.at).expect("format_time output parses");
    VerifiedRecord {
        id,
        body_json,
        payload,
        at,
    }
}

fn signed_message(payload: &str) -> String {
    format!("{CHAT_DOMAIN}{payload}")
}

/// Full check of a received record body: size, JSON shape, version,
/// organization, field formats, signature, and not too far in the future.
pub fn verify_record(
    body_json: &str,
    org: &str,
    now: OffsetDateTime,
) -> Result<VerifiedRecord, Rejection> {
    if body_json.len() > MAX_RECORD_BYTES {
        return Err(Rejection::new("too_large", "record terlalu besar"));
    }
    let signed: SignedRecord = serde_json::from_str(body_json)
        .map_err(|e| Rejection::new("bad_format", format!("bukan record chat: {e}")))?;
    // The id is BLAKE3 of the body but the signature covers only `payload`.
    // Without this check a relaying laptop could re-encode the outer JSON
    // (spaces, key order, escapes) and give a signed record a new id, which
    // would dodge deletes and acks that name the original id.
    if serde_json::to_string(&signed).ok().as_deref() != Some(body_json) {
        return Err(Rejection::new("not_canonical", "record bukan bentuk baku"));
    }
    if !is_lower_hex(&signed.sig, 128) {
        return Err(Rejection::new(
            "bad_signature",
            "tanda tangan harus 128 karakter hex huruf kecil",
        ));
    }
    let payload: Payload = serde_json::from_str(&signed.payload)
        .map_err(|e| Rejection::new("bad_format", format!("isi record tidak dikenal: {e}")))?;
    if payload.v != CHAT_VERSION {
        return Err(Rejection::new(
            "bad_version",
            format!("versi record {} tidak dikenal", payload.v),
        ));
    }
    if payload.org != org {
        return Err(Rejection::new("wrong_org", "record untuk organisasi lain"));
    }
    let at = validate_payload(&payload).map_err(|d| Rejection::new("bad_format", d))?;
    if !verify_hex(
        &payload.author,
        signed_message(&signed.payload).as_bytes(),
        &signed.sig,
    ) {
        return Err(Rejection::new(
            "bad_signature",
            "tanda tangan tidak cocok dengan kunci pembuat",
        ));
    }
    if at > now + MAX_CLOCK_AHEAD {
        return Err(Rejection::new(
            "future",
            "waktu record lebih dari 10 menit di depan jam laptop ini",
        ));
    }
    Ok(VerifiedRecord {
        id: crate::network::feature::record_id(body_json),
        body_json: body_json.to_owned(),
        payload,
        at,
    })
}

/// Parses a body stored earlier (already verified) without checking the
/// signature or clock again.
pub fn parse_stored(body_json: &str) -> Result<VerifiedRecord, String> {
    let signed: SignedRecord = serde_json::from_str(body_json).map_err(|e| e.to_string())?;
    let payload: Payload = serde_json::from_str(&signed.payload).map_err(|e| e.to_string())?;
    let at = validate_payload(&payload)?;
    Ok(VerifiedRecord {
        id: crate::network::feature::record_id(body_json),
        body_json: body_json.to_owned(),
        payload,
        at,
    })
}

/// Field checks. Returns the parsed `at`.
pub fn validate_payload(p: &Payload) -> Result<OffsetDateTime, String> {
    if !is_lower_hex(&p.org, 32) {
        return Err("org harus 32 hex".into());
    }
    if !is_key(&p.author) {
        return Err("author harus 64 hex".into());
    }
    if !is_lower_hex(&p.nonce, 32) {
        return Err("nonce harus 32 hex".into());
    }
    let at = parse_time(&p.at).ok_or("at bukan waktu RFC 3339")?;
    if !(MIN_YEAR..=MAX_YEAR).contains(&at.year()) {
        return Err("tahun di luar 2020 sampai 2100".into());
    }
    validate_body(p)?;
    Ok(at)
}

fn validate_body(p: &Payload) -> Result<(), String> {
    let author = p.author.as_str();
    match &p.body {
        Body::ChannelCreate {
            channel,
            name,
            scope,
        } => {
            if *channel != derive_channel_id(&p.org, author, &p.nonce) {
                return Err("id channel bukan turunan pembuat dan nonce".into());
            }
            if !is_channel_name(name) {
                return Err("nama channel tidak sah".into());
            }
            match scope {
                ChannelScope::Org => {}
                ChannelScope::Team { id } | ChannelScope::Project { id } => {
                    if !is_lower_hex(id, 32) {
                        return Err("id cakupan harus 32 hex".into());
                    }
                }
            }
        }
        Body::ChannelArchive { conv, .. } | Body::ChannelDelete { conv } => {
            if !matches!(parse_conv(conv), Some(Conv::Channel(_))) {
                return Err("arsip dan hapus hanya untuk channel".into());
            }
        }
        Body::Message {
            conv,
            text,
            reply_to,
            mentions,
            files,
        } => {
            parse_conv(conv).ok_or("conv tidak sah")?;
            let chars = text.chars().count();
            if chars > MAX_TEXT_CHARS {
                return Err("teks pesan terlalu panjang".into());
            }
            if text.trim().is_empty() && files.is_empty() {
                return Err("pesan kosong".into());
            }
            if text.chars().any(|c| is_bad_text_char(c) || is_bidi_control(c)) {
                return Err("teks berisi karakter kontrol".into());
            }
            if let Some(r) = reply_to
                && !is_key(r)
            {
                return Err("reply_to harus 64 hex".into());
            }
            if mentions.len() > MAX_MENTIONS || !mentions.iter().all(|m| is_key(m)) {
                return Err("mentions tidak sah".into());
            }
            if has_duplicates(mentions) {
                return Err("mentions berulang".into());
            }
            if files.len() > MAX_FILES {
                return Err("terlalu banyak file".into());
            }
            for f in files {
                validate_file(f)?;
            }
        }
        Body::MessageDelete {
            conv,
            message,
            message_author,
            message_at,
        } => {
            parse_conv(conv).ok_or("conv tidak sah")?;
            if !is_key(message) || !is_key(message_author) {
                return Err("message dan message_author harus 64 hex".into());
            }
            parse_time(message_at).ok_or("message_at bukan waktu RFC 3339")?;
        }
        Body::Receipt { conv, messages, .. } => {
            parse_conv(conv).ok_or("conv tidak sah")?;
            if messages.is_empty() || messages.len() > MAX_RECEIPT_MESSAGES {
                return Err("jumlah pesan di tanda terima tidak sah".into());
            }
            if !messages.iter().all(|m| is_key(m)) || has_duplicates(messages) {
                return Err("id pesan di tanda terima tidak sah".into());
            }
        }
        Body::Envelope {
            to,
            sealed,
            cipher_files,
        } => {
            if !is_key(to) {
                return Err("to harus 64 hex".into());
            }
            if to == author {
                return Err("titipan untuk diri sendiri".into());
            }
            if sealed.is_empty() || sealed.len() > MAX_SEALED_CHARS || !is_base64(sealed) {
                return Err("isi titipan tidak sah".into());
            }
            if cipher_files.len() > MAX_FILES {
                return Err("terlalu banyak file titipan".into());
            }
            for f in cipher_files {
                if !is_key(&f.hash) || f.size == 0 || f.size > MAX_CIPHER_FILE_BYTES {
                    return Err("file titipan tidak sah".into());
                }
            }
        }
        Body::EnvelopeAck { envelope } => {
            if !is_key(envelope) {
                return Err("envelope harus 64 hex".into());
            }
        }
    }
    Ok(())
}

fn validate_file(f: &FileRef) -> Result<(), String> {
    if !is_key(&f.hash) {
        return Err("hash file harus 64 hex".into());
    }
    if f.size == 0 || f.size > MAX_FILE_BYTES {
        return Err("ukuran file tidak sah".into());
    }
    if !is_file_name(&f.name) {
        return Err("nama file tidak sah".into());
    }
    if f.mime.is_empty()
        || f.mime.len() > MAX_MIME_CHARS
        || !f
            .mime
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"/.+-_".contains(&b))
    {
        return Err("jenis file tidak sah".into());
    }
    Ok(())
}

fn has_duplicates(items: &[String]) -> bool {
    let mut seen = std::collections::HashSet::new();
    !items.iter().all(|i| seen.insert(i))
}

fn is_bad_text_char(c: char) -> bool {
    c.is_control() && c != '\n' && c != '\t'
}

/// Bidi embedding, override, isolate and mark characters: they make text or
/// a file name display differently from what it is (`kontrak\u{202E}fdp.exe`).
fn is_bidi_control(c: char) -> bool {
    matches!(
        c,
        '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' | '\u{200E}' | '\u{200F}' | '\u{061C}'
    )
}

/// Unicode format characters (category Cf) that matter in file names: bidi
/// controls, zero-width characters, soft hyphen, BOM, interlinear and tag
/// characters.
fn is_format_char(c: char) -> bool {
    is_bidi_control(c)
        || matches!(
            c,
            '\u{00AD}'
                | '\u{180E}'
                | '\u{200B}'..='\u{200D}'
                | '\u{2060}'..='\u{2064}'
                | '\u{FEFF}'
                | '\u{FFF9}'..='\u{FFFB}'
                | '\u{E0001}'
                | '\u{E0020}'..='\u{E007F}'
        )
}

/// Windows device names, with or without extension (`CON`, `nul.txt`, `COM1`).
fn is_reserved_windows_name(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ((stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.len() == 4
            && stem.as_bytes()[3].is_ascii_digit())
}

fn is_base64(s: &str) -> bool {
    data_encoding::BASE64.decode(s.as_bytes()).is_ok()
}

/// 64 lowercase hex (public keys, record ids, blob hashes).
pub fn is_key(s: &str) -> bool {
    is_lower_hex(s, 64)
}

/// 1 to 40 characters of `a-z`, `0-9` and `-`, not starting or ending with `-`.
pub fn is_channel_name(name: &str) -> bool {
    let len = name.chars().count();
    (1..=MAX_CHANNEL_NAME_CHARS).contains(&len)
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !name.starts_with('-')
        && !name.ends_with('-')
}

/// Turns what someone typed into a channel name: trimmed, lowercase, spaces
/// and underscores become `-`, a leading `#` is dropped, other characters
/// are removed, repeated `-` collapse. `None` when nothing usable is left.
pub fn normalize_channel_name(input: &str) -> Option<String> {
    let mut out = String::new();
    for c in input.trim().trim_start_matches('#').chars() {
        let c = c.to_ascii_lowercase();
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            out.push(c);
        } else if (c == ' ' || c == '-' || c == '_') && !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
    }
    let out: String = out.trim_matches('-').chars().take(MAX_CHANNEL_NAME_CHARS).collect();
    let out = out.trim_end_matches('-').to_owned();
    is_channel_name(&out).then_some(out)
}

/// 1 to 200 characters, no path separators, no characters Windows refuses in
/// file names, no control or format characters, no Windows device names, no
/// trailing dot or space, not `.` or `..`.
pub fn is_file_name(name: &str) -> bool {
    let len = name.chars().count();
    (1..=MAX_FILE_NAME_CHARS).contains(&len)
        && name.trim() == name
        && !name.ends_with('.')
        && !is_reserved_windows_name(name)
        && !name
            .chars()
            .any(|c| c.is_control() || is_format_char(c) || "\\/:*?\"<>|".contains(c))
}

/// Extensions Windows runs or interprets as code when a file is opened. Such
/// attachments are offered for saving only, never opened from Mira.
pub fn is_executable_name(name: &str) -> bool {
    const EXT: &[&str] = &[
        "exe", "com", "bat", "cmd", "scr", "pif", "msi", "msp", "msc", "lnk", "url", "hta", "js",
        "jse", "vbs", "vbe", "wsf", "wsh", "ps1", "psm1", "reg", "cpl", "jar", "appref-ms",
        "application", "gadget", "inf", "scf", "chm", "dll", "sys", "iso", "img", "vhd", "vhdx",
        "library-ms", "settingcontent-ms", "xll", "appx", "msix", "diagcab",
    ];
    name.rsplit_once('.')
        .map(|(_, ext)| EXT.contains(&ext.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// A conversation id, parsed.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Conv {
    /// `ch:<32 hex>`.
    Channel(String),
    /// `dm:<key>:<key>`, keys sorted, different.
    Direct(String, String),
}

pub fn channel_conv(channel_id: &str) -> String {
    format!("ch:{channel_id}")
}

/// `dm:` id for two different keys, in either order.
pub fn dm_conv(a: &str, b: &str) -> String {
    let (x, y) = if a <= b { (a, b) } else { (b, a) };
    format!("dm:{x}:{y}")
}

pub fn parse_conv(conv: &str) -> Option<Conv> {
    if let Some(id) = conv.strip_prefix("ch:") {
        return is_lower_hex(id, 32).then(|| Conv::Channel(id.to_owned()));
    }
    let rest = conv.strip_prefix("dm:")?;
    let (a, b) = rest.split_once(':')?;
    (is_key(a) && is_key(b) && a < b).then(|| Conv::Direct(a.to_owned(), b.to_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::{MemoryKeyStore, ensure_identity};
    use proptest::prelude::*;

    const ORG: &str = "0123456789abcdef0123456789abcdef";

    fn identity() -> (tempfile::TempDir, Identity) {
        let tmp = tempfile::tempdir().unwrap();
        let conn = crate::db::open(tmp.path()).unwrap();
        let id = ensure_identity(&conn, &MemoryKeyStore::new()).unwrap();
        (tmp, id)
    }

    fn now() -> OffsetDateTime {
        parse_time("2026-11-22T08:00:00Z").unwrap()
    }

    fn message(conv: &str, text: &str) -> Body {
        Body::Message {
            conv: conv.into(),
            text: text.into(),
            reply_to: None,
            mentions: vec![],
            files: vec![],
        }
    }

    fn umum() -> String {
        channel_conv(&"a".repeat(32))
    }

    #[test]
    fn signed_record_verifies_and_id_is_blake3_of_body() {
        let (_t, id) = identity();
        let rec = sign_record(&id, ORG, now(), message(&umum(), "halo"));
        let fr = rec.to_feature_record();
        assert!(fr.id_matches());
        let back = verify_record(&fr.body, ORG, now()).unwrap();
        assert_eq!(back, rec);
        assert_eq!(back.author(), id.public_key_hex());
    }

    #[test]
    fn same_content_twice_gets_different_ids() {
        let (_t, id) = identity();
        let a = sign_record(&id, ORG, now(), message(&umum(), "halo"));
        let b = sign_record(&id, ORG, now(), message(&umum(), "halo"));
        assert_ne!(a.id, b.id);
    }

    #[test]
    fn tampered_payload_or_signature_is_refused() {
        let (_t, id) = identity();
        let rec = sign_record(&id, ORG, now(), message(&umum(), "halo"));
        let tampered = rec.body_json.replace("halo", "hai!");
        assert_eq!(verify_record(&tampered, ORG, now()).unwrap_err().code, "bad_signature");

        let mut signed: SignedRecord = serde_json::from_str(&rec.body_json).unwrap();
        let flip = if signed.sig.starts_with('0') { "1" } else { "0" };
        signed.sig.replace_range(0..1, flip);
        let body = serde_json::to_string(&signed).unwrap();
        assert_eq!(verify_record(&body, ORG, now()).unwrap_err().code, "bad_signature");
    }

    #[test]
    fn author_swap_is_refused() {
        let (_t, a) = identity();
        let (_t2, b) = identity();
        let rec = sign_record(&a, ORG, now(), message(&umum(), "halo"));
        let forged = rec
            .body_json
            .replace(a.public_key_hex(), b.public_key_hex());
        assert_eq!(verify_record(&forged, ORG, now()).unwrap_err().code, "bad_signature");
    }

    #[test]
    fn wrong_org_future_and_garbage_are_refused() {
        let (_t, id) = identity();
        let rec = sign_record(&id, ORG, now(), message(&umum(), "halo"));
        let other = "f".repeat(32);
        assert_eq!(verify_record(&rec.body_json, &other, now()).unwrap_err().code, "wrong_org");

        let later = now() + time::Duration::minutes(11);
        let future = sign_record(&id, ORG, later, message(&umum(), "halo"));
        assert_eq!(verify_record(&future.body_json, ORG, now()).unwrap_err().code, "future");
        assert!(verify_record(&future.body_json, ORG, later).is_ok());

        assert_eq!(verify_record("{}", ORG, now()).unwrap_err().code, "bad_format");
        assert_eq!(verify_record("bukan json", ORG, now()).unwrap_err().code, "bad_format");
    }

    #[test]
    fn unknown_fields_and_kinds_are_refused() {
        let (_t, id) = identity();
        let rec = sign_record(&id, ORG, now(), message(&umum(), "halo"));
        let body = rec.body_json.replace("\\\"kind\\\":\\\"message\\\"", "\\\"kind\\\":\\\"poll\\\"");
        assert_ne!(body, rec.body_json);
        assert!(verify_record(&body, ORG, now()).is_err());
    }

    #[test]
    fn field_rules() {
        let (_t, id) = identity();
        let check = |body: Body| {
            let rec = sign_record(&id, ORG, now(), body);
            verify_record(&rec.body_json, ORG, now()).map(|_| ())
        };
        assert!(check(message(&umum(), "")).is_err(), "empty message");
        assert!(check(message(&umum(), &"x".repeat(MAX_TEXT_CHARS + 1))).is_err());
        assert!(check(message(&umum(), &"x".repeat(MAX_TEXT_CHARS))).is_ok());
        assert!(check(message(&umum(), "baris\nbaru\tok")).is_ok());
        assert!(check(message(&umum(), "bel\u{7}")).is_err());
        assert!(check(message("ch:xyz", "halo")).is_err());
        assert!(check(message(&dm_conv(&"b".repeat(64), &"a".repeat(64)), "halo")).is_ok());

        let file = |name: &str, size: u64| FileRef {
            hash: "c".repeat(64),
            size,
            name: name.into(),
            mime: "application/pdf".into(),
        };
        let with_files = |files: Vec<FileRef>| Body::Message {
            conv: umum(),
            text: String::new(),
            reply_to: None,
            mentions: vec![],
            files,
        };
        assert!(check(with_files(vec![file("kontrak.pdf", 10)])).is_ok());
        assert!(check(with_files(vec![file("..", 10)])).is_err());
        assert!(check(with_files(vec![file("a/b.pdf", 10)])).is_err());
        assert!(check(with_files(vec![file("kontrak.pdf", 0)])).is_err());
        assert!(check(with_files(vec![file("k.pdf", MAX_FILE_BYTES + 1)])).is_err());
        assert!(check(with_files(vec![file("k.pdf", 1); MAX_FILES + 1])).is_err());

        let dup = Body::Message {
            conv: umum(),
            text: "halo".into(),
            reply_to: None,
            mentions: vec!["b".repeat(64), "b".repeat(64)],
            files: vec![],
        };
        assert!(check(dup).is_err());

        assert!(check(Body::ChannelCreate {
            channel: "1".repeat(32),
            name: "proyek-a".into(),
            scope: ChannelScope::Team { id: "2".repeat(32) },
        })
        .is_ok(), "sign_record derives the channel id");
        assert!(check(Body::ChannelCreate {
            channel: "1".repeat(32),
            name: "Proyek A".into(),
            scope: ChannelScope::Org,
        })
        .is_err());
        assert!(check(Body::ChannelArchive {
            conv: dm_conv(&"a".repeat(64), &"b".repeat(64)),
            archived: true,
        })
        .is_err());
        assert!(check(Body::Receipt {
            conv: umum(),
            state: ReceiptState::Read,
            messages: vec![],
        })
        .is_err());
        assert!(check(Body::Envelope {
            to: id.public_key_hex().to_owned(),
            sealed: "AAAA".into(),
            cipher_files: vec![],
        })
        .is_err(), "envelope to self");
        assert!(check(Body::Envelope {
            to: "b".repeat(64),
            sealed: "bukan base64!".into(),
            cipher_files: vec![],
        })
        .is_err());
        assert!(check(Body::Envelope {
            to: "b".repeat(64),
            sealed: "AAAA".into(),
            cipher_files: vec![],
        })
        .is_ok());
    }

    #[test]
    fn re_encoded_body_is_refused() {
        let (_t, id) = identity();
        let rec = sign_record(&id, ORG, now(), message(&umum(), "halo"));
        let signed: SignedRecord = serde_json::from_str(&rec.body_json).unwrap();
        let spaced = format!("{{ \"payload\": {}, \"sig\": \"{}\" }}", serde_json::to_string(&signed.payload).unwrap(), signed.sig);
        assert_eq!(verify_record(&spaced, ORG, now()).unwrap_err().code, "not_canonical");
        let swapped = format!("{{\"sig\":\"{}\",\"payload\":{}}}", signed.sig, serde_json::to_string(&signed.payload).unwrap());
        assert_eq!(verify_record(&swapped, ORG, now()).unwrap_err().code, "not_canonical");
    }

    #[test]
    fn channel_id_is_derived_and_cannot_be_chosen() {
        let (_t, id) = identity();
        let rec = sign_record(
            &id,
            ORG,
            now(),
            Body::ChannelCreate {
                channel: "0".repeat(32),
                name: "desain".into(),
                scope: ChannelScope::Org,
            },
        );
        let Body::ChannelCreate { channel, .. } = rec.body() else { panic!() };
        assert_eq!(*channel, derive_channel_id(ORG, id.public_key_hex(), &rec.payload.nonce));
        assert!(verify_record(&rec.body_json, ORG, now()).is_ok());

        // A record that claims a chosen id fails validation (signed by hand).
        let mut payload = rec.payload.clone();
        payload.body = Body::ChannelCreate {
            channel: "a".repeat(32),
            name: "desain".into(),
            scope: ChannelScope::Org,
        };
        let payload_json = serde_json::to_string(&payload).unwrap();
        let sig = id.sign(signed_message(&payload_json).as_bytes());
        let body = serde_json::to_string(&SignedRecord {
            payload: payload_json,
            sig: hex::encode(sig.to_bytes()),
        })
        .unwrap();
        assert_eq!(verify_record(&body, ORG, now()).unwrap_err().code, "bad_format");
    }

    #[test]
    fn dangerous_file_names_and_text() {
        for bad in [
            "kontrak\u{202E}fdp.exe",
            "a\u{200B}b.pdf",
            "CON",
            "nul.txt",
            "COM1.pdf",
            "laporan.",
            "laporan ",
            " laporan",
            "..",
            ".",
        ] {
            assert!(!is_file_name(bad), "{bad:?}");
        }
        for good in ["Laporan Q3.xlsx", "kontrak (final).pdf", "console.log", "COM10.txt", ".gitignore"] {
            assert!(is_file_name(good), "{good:?}");
        }
        assert!(is_executable_name("Laporan.pdf.exe"));
        assert!(is_executable_name("pintasan.LNK"));
        assert!(!is_executable_name("laporan.pdf"));
        assert!(!is_executable_name("tanpa-ekstensi"));

        let (_t, id) = identity();
        let rec = sign_record(&id, ORG, now(), message(&umum(), "abc\u{202E}def"));
        assert!(verify_record(&rec.body_json, ORG, now()).is_err());
        let emoji = sign_record(&id, ORG, now(), message(&umum(), "keluarga \u{1F468}\u{200D}\u{1F469}"));
        assert!(verify_record(&emoji.body_json, ORG, now()).is_ok(), "ZWJ in text stays allowed");
    }

    #[test]
    fn conv_ids() {
        let a = "a".repeat(64);
        let b = "b".repeat(64);
        assert_eq!(dm_conv(&a, &b), dm_conv(&b, &a));
        assert_eq!(parse_conv(&dm_conv(&b, &a)), Some(Conv::Direct(a.clone(), b.clone())));
        assert_eq!(parse_conv(&format!("dm:{b}:{a}")), None, "unsorted");
        assert_eq!(parse_conv(&format!("dm:{a}:{a}")), None, "same key");
        assert_eq!(parse_conv(&umum()), Some(Conv::Channel("a".repeat(32))));
        assert_eq!(parse_conv("ch:ABC"), None);
        assert_eq!(parse_conv(""), None);
    }

    #[test]
    fn channel_names() {
        assert_eq!(normalize_channel_name("  #Proyek A "), Some("proyek-a".into()));
        assert_eq!(normalize_channel_name("Desain__Interior 2026"), Some("desain-interior-2026".into()));
        assert_eq!(normalize_channel_name("---"), None);
        assert_eq!(normalize_channel_name("!!!"), None);
        assert_eq!(normalize_channel_name(&"a".repeat(60)).unwrap().len(), 40);
        assert!(!is_channel_name("-a"));
        assert!(!is_channel_name(""));
    }

    #[test]
    fn apply_rank_orders_dependencies() {
        let create = Body::ChannelCreate {
            channel: "1".repeat(32),
            name: "a".into(),
            scope: ChannelScope::Org,
        };
        let ack = Body::EnvelopeAck {
            envelope: "1".repeat(64),
        };
        assert!(create.apply_rank() < message(&umum(), "x").apply_rank());
        assert!(message(&umum(), "x").apply_rank() < ack.apply_rank());
        assert_eq!(create.conv(), Some(channel_conv(&"1".repeat(32))));
        assert_eq!(ack.conv(), None);
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(64))]

        #[test]
        fn any_valid_message_roundtrips(text in "[a-zA-Z0-9 .,!?\n]{1,200}", mention in proptest::option::of("[0-9a-f]{64}")) {
            prop_assume!(!text.trim().is_empty());
            let (_t, id) = identity();
            let body = Body::Message {
                conv: umum(),
                text,
                reply_to: None,
                mentions: mention.into_iter().collect(),
                files: vec![],
            };
            let rec = sign_record(&id, ORG, now(), body);
            let back = verify_record(&rec.body_json, ORG, now()).unwrap();
            prop_assert_eq!(back.payload, rec.payload);
        }

        #[test]
        fn single_byte_change_never_verifies(pos in 0usize..400, byte in 0u8..128) {
            let (_t, id) = identity();
            let rec = sign_record(&id, ORG, now(), message(&umum(), "pesan penting"));
            let mut bytes = rec.body_json.clone().into_bytes();
            let pos = pos % bytes.len();
            prop_assume!(bytes[pos] != byte);
            bytes[pos] = byte;
            if let Ok(s) = String::from_utf8(bytes) {
                // Either it no longer parses, or the signature fails; the
                // only exception is JSON whitespace or escapes that decode
                // to the same payload string, which must then verify to the
                // same payload.
                if let Ok(v) = verify_record(&s, ORG, now()) {
                    prop_assert_eq!(v.payload, rec.payload);
                }
            }
        }

        #[test]
        fn normalized_names_are_valid(input in ".{0,80}") {
            if let Some(n) = normalize_channel_name(&input) {
                prop_assert!(is_channel_name(&n));
            }
        }

        #[test]
        fn parse_conv_never_panics(s in ".{0,200}") {
            let _ = parse_conv(&s);
        }
    }
}
