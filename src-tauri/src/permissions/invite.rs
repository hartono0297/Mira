//! Invite codes, the key derived from a code, and the redeem proof (plan 1.3).

use ed25519_dalek::{Signer, SigningKey};
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};

use super::format::CROCKFORD;
use super::op::InviteRole;
use crate::error::{AppError, AppResult};
use crate::identity::Identity;

pub const CODE_LEN: usize = 20;
pub const INVITE_KEY_CONTEXT: &str = "mira invite key v1";
pub const REDEEM_DOMAIN: &str = "mira-invite-redeem-v1";

/// A code after normalization: 20 uppercase Crockford characters, no dashes.
/// It is a secret, so `Debug` does not print it.
#[derive(Clone, PartialEq, Eq)]
pub struct NormalizedCode(String);

impl std::fmt::Debug for NormalizedCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "NormalizedCode({}...)", self.tag())
    }
}

impl NormalizedCode {
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// First 8 characters (40 bits), used to look the invite up.
    pub fn tag(&self) -> &str {
        &self.0[..8]
    }

    /// `ABCD-EFGH-JKMN-PQRS-TVWX`.
    pub fn formatted(&self) -> String {
        self.0
            .as_bytes()
            .chunks(4)
            .map(|c| std::str::from_utf8(c).unwrap_or_default())
            .collect::<Vec<_>>()
            .join("-")
    }
}

/// 100 random bits as 20 Crockford base32 characters in five groups of four.
pub fn generate_invite_code() -> String {
    let mut bytes = [0u8; CODE_LEN];
    OsRng.fill_bytes(&mut bytes);
    // 256 is a multiple of 32, so `b & 31` is uniform.
    let code: String = bytes
        .iter()
        .map(|b| CROCKFORD[(b & 31) as usize] as char)
        .collect();
    NormalizedCode(code).formatted()
}

/// Accepts lowercase, spaces and dashes; reads I and L as 1 and O as 0.
pub fn normalize_code(input: &str) -> AppResult<NormalizedCode> {
    let mut out = String::with_capacity(CODE_LEN);
    for c in input.chars() {
        if c.is_whitespace() || c == '-' {
            continue;
        }
        let c = match c.to_ascii_uppercase() {
            'I' | 'L' => '1',
            'O' => '0',
            c => c,
        };
        if !c.is_ascii() || !CROCKFORD.contains(&(c as u8)) {
            return Err(AppError::InviteInvalid);
        }
        out.push(c);
        if out.len() > CODE_LEN {
            return Err(AppError::InviteInvalid);
        }
    }
    if out.len() != CODE_LEN {
        return Err(AppError::InviteInvalid);
    }
    Ok(NormalizedCode(out))
}

/// `SigningKey::from_bytes(blake3::derive_key("mira invite key v1", code))`.
pub fn invite_signing_key(code: &NormalizedCode) -> SigningKey {
    SigningKey::from_bytes(&blake3::derive_key(
        INVITE_KEY_CONTEXT,
        code.as_str().as_bytes(),
    ))
}

/// Public invite key as 64 lowercase hex (stored in `invite_create.key`).
pub fn invite_public_key(code: &NormalizedCode) -> String {
    hex::encode(invite_signing_key(code).verifying_key().as_bytes())
}

/// `"mira-invite-redeem-v1\n{org}\n{invite}\n{member}\n{name}"`.
pub fn redeem_message(org: &str, invite: &str, member: &str, name: &str) -> Vec<u8> {
    [REDEEM_DOMAIN, org, invite, member, name]
        .join("\n")
        .into_bytes()
}

pub const INVITE_KEY_DOMAIN: &str = "mira-invite-key-v1";

/// What the invite key signs when the invite is created (`key_sig`):
/// `"mira-invite-key-v1\n{org}\n{founder}\n{author}\n{invite}\n{team}\n{role}\n{projects, comma separated}\n{expires}\n{single_use}\n{tag}"`.
///
/// Only someone holding the code can make it, so the public key of an
/// invite cannot be copied into another invite (another team or role) or
/// into a look-alike organization made by someone who saw the log. The
/// joining laptop relies on this: the invite that admitted it is bound to
/// the organization it is shown.
#[allow(clippy::too_many_arguments)]
pub fn invite_key_message(
    org: &str,
    founder: &str,
    author: &str,
    invite: &str,
    team: &str,
    role: InviteRole,
    projects: &[String],
    expires: &str,
    single_use: bool,
    tag: &str,
) -> Vec<u8> {
    let projects = projects.join(",");
    let single_use = if single_use { "1" } else { "0" };
    [
        INVITE_KEY_DOMAIN,
        org,
        founder,
        author,
        invite,
        team,
        role.as_str(),
        &projects,
        expires,
        single_use,
        tag,
    ]
    .join("\n")
    .into_bytes()
}

/// `key_sig` for `invite_key_message`, signed with the code's key.
pub fn sign_invite_key(code: &NormalizedCode, message: &[u8]) -> String {
    hex::encode(invite_signing_key(code).sign(message).to_bytes())
}

/// What the joining laptop proves (same shape as `network::JoinProof`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct JoinProofData {
    pub member: String,
    pub name: String,
    pub invite_sig: String,
    pub member_sig: String,
}

/// Signs the redeem message with the invite key and this laptop's key.
/// Needs a display name (`name_required` otherwise).
pub fn build_join_proof(
    code: &NormalizedCode,
    org: &str,
    invite: &str,
    identity: &Identity,
) -> AppResult<JoinProofData> {
    let name = identity.display_name().ok_or(AppError::NameRequired)?;
    Ok(sign_proof(
        code,
        org,
        invite,
        identity.public_key_hex(),
        name,
        |m| identity.sign(m),
    ))
}

pub(crate) fn sign_proof(
    code: &NormalizedCode,
    org: &str,
    invite: &str,
    member: &str,
    name: &str,
    member_sign: impl FnOnce(&[u8]) -> ed25519_dalek::Signature,
) -> JoinProofData {
    let msg = redeem_message(org, invite, member, name);
    JoinProofData {
        member: member.to_owned(),
        name: name.to_owned(),
        invite_sig: hex::encode(invite_signing_key(code).sign(&msg).to_bytes()),
        member_sig: hex::encode(member_sign(&msg).to_bytes()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_codes_have_the_documented_shape() {
        for _ in 0..50 {
            let code = generate_invite_code();
            assert_eq!(code.len(), 24, "{code}");
            let groups: Vec<&str> = code.split('-').collect();
            assert_eq!(groups.len(), 5);
            assert!(groups.iter().all(|g| g.len() == 4));
            let n = normalize_code(&code).unwrap();
            assert_eq!(n.formatted(), code);
        }
        assert_ne!(generate_invite_code(), generate_invite_code());
    }

    #[test]
    fn normalization_accepts_friendly_input() {
        let n = normalize_code("abcd-efgh-jkmn-pqrs-tvwx").unwrap();
        assert_eq!(n.as_str(), "ABCDEFGHJKMNPQRSTVWX");
        assert_eq!(n.tag(), "ABCDEFGH");
        assert_eq!(n.formatted(), "ABCD-EFGH-JKMN-PQRS-TVWX");
        assert_eq!(normalize_code(" ABCD EFGH  JKMN\tPQRS TVWX ").unwrap(), n);
        assert_eq!(
            normalize_code("i0lo-0000-0000-0000-0000").unwrap().as_str(),
            "10100000000000000000"
        );
    }

    #[test]
    fn normalization_rejects_bad_codes() {
        for bad in [
            "",
            "ABCD-EFGH-JKMN-PQRS-TVW",
            "ABCD-EFGH-JKMN-PQRS-TVWXY",
            "ABCD-EFGH-JKMN-PQRS-TVWU",
            "ABCD-EFGH-JKMN-PQRS-TVW!",
            "ABCD-EFGH-JKMN-PQRS-TVWÄ",
            "ABCD_EFGH_JKMN_PQRS_TVWX",
        ] {
            assert_eq!(
                normalize_code(bad).unwrap_err().code(),
                "invite_invalid",
                "{bad}"
            );
        }
    }

    #[test]
    fn invite_key_is_deterministic_per_code() {
        let a = normalize_code("ABCD-EFGH-JKMN-PQRS-TVWX").unwrap();
        let b = normalize_code("abcdefghjkmnpqrstvwx").unwrap();
        let c = normalize_code("ABCD-EFGH-JKMN-PQRS-TVWY").unwrap();
        assert_eq!(invite_public_key(&a), invite_public_key(&b));
        assert_ne!(invite_public_key(&a), invite_public_key(&c));
        assert_eq!(invite_public_key(&a).len(), 64);
    }

    #[test]
    fn redeem_message_format() {
        assert_eq!(
            redeem_message("o", "i", "m", "Budi"),
            b"mira-invite-redeem-v1\no\ni\nm\nBudi".to_vec()
        );
    }

    #[test]
    fn debug_does_not_leak_the_code() {
        let n = normalize_code("ABCD-EFGH-JKMN-PQRS-TVWX").unwrap();
        let dbg = format!("{n:?}");
        assert!(!dbg.contains("JKMN"), "{dbg}");
    }
}
