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
    pub at: String,
    pub nonce: String,
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
            at: "2026-11-23T08:00:00Z".into(),
            nonce: "cd".repeat(16),
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
}
