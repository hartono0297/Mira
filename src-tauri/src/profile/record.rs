//! Profile records (docs/plans/foto-profil.md, section 2.3): format,
//! signature, checks, and the effective photo per owner.
//!
//! A record body is the canonical JSON of [`ProfileRecord`]: fields in
//! declaration order, no spaces, `null` for empty `photo`/`size`. `parse`
//! re-encodes what it read and refuses any body that differs, so one record
//! has exactly one body and one id.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::MAX_PHOTO_BYTES;
use crate::chat::audience::Directory;
use crate::error::{AppError, AppResult};
use crate::identity::{self, Identity};
use crate::permissions::format::{format_time, parse_time};

/// Format version written in `v`.
pub const RECORD_VERSION: u32 = 1;

/// Prefix of the signed bytes, so a profile signature can never pass as a
/// signature of another feature.
pub const SIGNING_DOMAIN: &[u8] = b"mira/profile/v1\n";

/// Largest `seq` accepted (SQLite stores it as a signed 64-bit integer).
pub const MAX_SEQ: u64 = i64::MAX as u64;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RecordKind {
    /// The owner shows `photo`.
    Set,
    /// The owner shows initials again.
    Clear,
    /// A superadmin hides the owner's photo `photo`.
    Remove,
}

impl RecordKind {
    pub fn as_str(self) -> &'static str {
        match self {
            RecordKind::Set => "set",
            RecordKind::Clear => "clear",
            RecordKind::Remove => "remove",
        }
    }

    pub fn parse(s: &str) -> Option<RecordKind> {
        match s {
            "set" => Some(RecordKind::Set),
            "clear" => Some(RecordKind::Clear),
            "remove" => Some(RecordKind::Remove),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProfileRecord {
    pub v: u32,
    pub kind: RecordKind,
    /// Organization id, 32 hex.
    pub org: String,
    /// Whose photo, 64 hex.
    pub owner: String,
    /// Signer, 64 hex; equal to `owner` for `set` and `clear`.
    pub author: String,
    /// BLAKE3 of the photo, 64 hex; set for `set` and `remove`.
    pub photo: Option<String>,
    /// Photo size in bytes; only for `set`.
    pub size: Option<u64>,
    /// Per-owner counter for `set`/`clear` (from 1); 0 for `remove`.
    pub seq: u64,
    /// RFC 3339, as written by `format_time`.
    pub at: String,
    /// Ed25519 signature over `signing_bytes()`, 128 hex.
    pub sig: String,
}

/// Why an otherwise well-formed record is refused on this laptop. `code` goes
/// into `rejected_changes` as `profile_<code>`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rejection {
    pub code: &'static str,
    pub detail: String,
}

impl Rejection {
    fn new(code: &'static str, detail: impl Into<String>) -> Self {
        Self {
            code,
            detail: detail.into(),
        }
    }
}

fn is_lower_hex(s: &str, len: usize) -> bool {
    s.len() == len && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn invalid(detail: &str) -> AppError {
    AppError::InvalidInput(format!("Record foto profil tidak valid: {detail}."))
}

impl ProfileRecord {
    /// Builds and signs a record with `identity` as author. Fails when the
    /// fields break the rules of `kind`.
    #[allow(clippy::too_many_arguments)]
    pub fn sign_new(
        identity: &Identity,
        kind: RecordKind,
        org: &str,
        owner: &str,
        photo: Option<&str>,
        size: Option<u64>,
        seq: u64,
        at: &str,
    ) -> AppResult<ProfileRecord> {
        let mut rec = ProfileRecord {
            v: RECORD_VERSION,
            kind,
            org: org.to_owned(),
            owner: owner.to_owned(),
            author: identity.public_key_hex().to_owned(),
            photo: photo.map(str::to_owned),
            size,
            seq,
            at: at.to_owned(),
            sig: String::new(),
        };
        rec.check_shape().map_err(|d| invalid(&d))?;
        rec.sign_with(identity);
        Ok(rec)
    }

    /// Signs the record as it is (author must already be `identity`).
    pub(crate) fn sign_with(&mut self, identity: &Identity) {
        self.sig = hex::encode(identity.sign(&self.signing_bytes()).to_bytes());
    }

    /// `SIGNING_DOMAIN` followed by the canonical JSON with an empty `sig`.
    pub fn signing_bytes(&self) -> Vec<u8> {
        let unsigned = ProfileRecord {
            sig: String::new(),
            ..self.clone()
        };
        let mut out = SIGNING_DOMAIN.to_vec();
        out.extend_from_slice(unsigned.to_body().as_bytes());
        out
    }

    /// The canonical JSON body.
    pub fn to_body(&self) -> String {
        serde_json::to_string(self).expect("a profile record always serializes")
    }

    /// Reads a body received from a colleague or the database. Refuses other
    /// encodings of the same record, bad hex, a bad signature, and fields
    /// that break the rules of the record's kind.
    pub fn parse(body: &str) -> AppResult<ProfileRecord> {
        let rec: ProfileRecord =
            serde_json::from_str(body).map_err(|e| invalid(&format!("JSON salah ({e})")))?;
        if rec.to_body() != body {
            return Err(invalid("encoding bukan bentuk kanonik"));
        }
        rec.check_shape().map_err(|d| invalid(&d))?;
        if !identity::verify_hex(&rec.author, &rec.signing_bytes(), &rec.sig) {
            return Err(invalid("tanda tangan tidak cocok"));
        }
        Ok(rec)
    }

    /// Field rules that need no database.
    fn check_shape(&self) -> Result<(), String> {
        if self.v != RECORD_VERSION {
            return Err(format!("versi {} tidak dikenal", self.v));
        }
        if !is_lower_hex(&self.org, 32) {
            return Err("id organisasi salah".into());
        }
        if !is_lower_hex(&self.owner, 64) || !is_lower_hex(&self.author, 64) {
            return Err("kunci pemilik atau penulis salah".into());
        }
        if !self.sig.is_empty() && !is_lower_hex(&self.sig, 128) {
            return Err("tanda tangan salah bentuk".into());
        }
        if let Some(p) = &self.photo
            && !is_lower_hex(p, 64)
        {
            return Err("hash foto salah".into());
        }
        if parse_time(&self.at).map(format_time).as_deref() != Some(self.at.as_str()) {
            return Err("waktu salah".into());
        }
        if self.seq > MAX_SEQ {
            return Err("nomor urut terlalu besar".into());
        }
        match self.kind {
            RecordKind::Set => {
                if self.photo.is_none() {
                    return Err("set tanpa foto".into());
                }
                if !self
                    .size
                    .is_some_and(|s| (1..=MAX_PHOTO_BYTES).contains(&s))
                {
                    return Err("ukuran foto salah".into());
                }
                if self.seq == 0 {
                    return Err("nomor urut set harus mulai dari 1".into());
                }
                if self.author != self.owner {
                    return Err("set hanya oleh pemilik".into());
                }
            }
            RecordKind::Clear => {
                if self.photo.is_some() || self.size.is_some() {
                    return Err("clear tidak membawa foto".into());
                }
                if self.seq == 0 {
                    return Err("nomor urut clear harus mulai dari 1".into());
                }
                if self.author != self.owner {
                    return Err("clear hanya oleh pemilik".into());
                }
            }
            RecordKind::Remove => {
                if self.photo.is_none() || self.size.is_some() {
                    return Err("remove harus menyebut satu foto tanpa ukuran".into());
                }
                if self.seq != 0 {
                    return Err("nomor urut remove harus 0".into());
                }
            }
        }
        Ok(())
    }

    /// Checks against this laptop's organization (on ingest): same
    /// organization, the owner is in `members` (any status), `set`/`clear`
    /// signed by the owner, `remove` signed by an active superadmin.
    pub fn check_against(&self, dir: &Directory) -> Result<(), Rejection> {
        if self.org != dir.org_id {
            return Err(Rejection::new("org", "record organisasi lain"));
        }
        if dir.member(&self.owner).is_none() {
            return Err(Rejection::new(
                "not_member",
                "pemilik bukan anggota organisasi",
            ));
        }
        match self.kind {
            RecordKind::Set | RecordKind::Clear if self.author != self.owner => Err(
                Rejection::new("not_owner", "hanya pemilik yang bisa mengubah fotonya"),
            ),
            RecordKind::Remove if !dir.is_superadmin(&self.author) => Err(Rejection::new(
                "not_superadmin",
                "hanya superadmin aktif yang bisa menghapus foto orang lain",
            )),
            _ => Ok(()),
        }
    }

    pub fn row(&self, id: &str) -> RecordRow {
        RecordRow {
            id: id.to_owned(),
            kind: self.kind,
            owner: self.owner.clone(),
            author: self.author.clone(),
            photo: self.photo.clone(),
            size: self.size,
            seq: self.seq,
            at: self.at.clone(),
        }
    }
}

/// The fields of a stored record that decide the effective state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecordRow {
    pub id: String,
    pub kind: RecordKind,
    pub owner: String,
    pub author: String,
    pub photo: Option<String>,
    pub size: Option<u64>,
    pub seq: u64,
    pub at: String,
}

/// What one owner shows, as this laptop sees it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct OwnerState {
    /// Id of the owner's winning `set`/`clear` record.
    pub latest: Option<String>,
    /// The photo the owner's latest record sets, with its size, removed or not.
    pub set: Option<(String, u64)>,
    /// `set`'s photo unless an active superadmin removed it: the photo
    /// colleagues should show and fetch.
    pub wanted: Option<String>,
    /// `wanted` when the photo is on this laptop: the photo shown here.
    pub photo: Option<String>,
    /// The latest record sets a photo that an active superadmin removed.
    pub removed_by_admin: bool,
    /// Ids of `remove` records for this owner by active superadmins.
    pub removes: Vec<String>,
}

/// Effective state per owner (pure). The latest owner record is the maximum
/// `(seq, at, id)` among `set`/`clear` signed by the owner; a `remove` counts
/// only while its author is an active superadmin now. `local` says whether a
/// photo is on this laptop (only photos that passed `is_valid_photo` are
/// stored, so presence is enough).
pub fn effective(
    records: &[RecordRow],
    dir: &Directory,
    local: &dyn Fn(&str) -> bool,
) -> BTreeMap<String, OwnerState> {
    let mut latest: BTreeMap<&str, &RecordRow> = BTreeMap::new();
    let mut removed: BTreeMap<&str, Vec<&RecordRow>> = BTreeMap::new();
    for r in records {
        match r.kind {
            RecordKind::Set | RecordKind::Clear if r.author == r.owner => {
                let key = (r.seq, r.at.as_str(), r.id.as_str());
                let wins = latest
                    .get(r.owner.as_str())
                    .is_none_or(|cur| key > (cur.seq, cur.at.as_str(), cur.id.as_str()));
                if wins {
                    latest.insert(&r.owner, r);
                }
            }
            RecordKind::Remove if dir.is_superadmin(&r.author) => {
                removed.entry(&r.owner).or_default().push(r);
            }
            _ => {}
        }
    }
    let mut out: BTreeMap<String, OwnerState> = BTreeMap::new();
    for (owner, rec) in &latest {
        let st = out.entry((*owner).to_owned()).or_default();
        st.latest = Some(rec.id.clone());
        if rec.kind == RecordKind::Set
            && let Some(hash) = &rec.photo
        {
            st.set = Some((hash.clone(), rec.size.unwrap_or(0)));
        }
    }
    for (owner, list) in &removed {
        let st = out.entry((*owner).to_owned()).or_default();
        let mut ids: Vec<String> = list.iter().map(|r| r.id.clone()).collect();
        ids.sort();
        st.removes = ids;
        if let Some((hash, _)) = &st.set {
            st.removed_by_admin = list.iter().any(|r| r.photo.as_deref() == Some(hash));
        }
    }
    for st in out.values_mut() {
        st.wanted = st
            .set
            .as_ref()
            .filter(|_| !st.removed_by_admin)
            .map(|(h, _)| h.clone());
        st.photo = st.wanted.clone().filter(|h| local(h));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::audience::MemberInfo;
    use crate::identity::{MemoryKeyStore, ensure_identity};

    const ORG: &str = "0123456789abcdef0123456789abcdef";
    const AT: &str = "2026-11-24T08:00:00Z";

    fn identity() -> Identity {
        let tmp = tempfile::tempdir().unwrap();
        let conn = crate::db::open(tmp.path()).unwrap();
        ensure_identity(&conn, &MemoryKeyStore::new()).unwrap()
    }

    fn hash(n: u8) -> String {
        blake3::hash(&[n]).to_hex().to_string()
    }

    fn set(id: &Identity, photo: &str, seq: u64, at: &str) -> ProfileRecord {
        let me = id.public_key_hex();
        ProfileRecord::sign_new(
            id,
            RecordKind::Set,
            ORG,
            me,
            Some(photo),
            Some(1000),
            seq,
            at,
        )
        .unwrap()
    }

    fn dir(members: &[(&str, bool, bool)]) -> Directory {
        Directory {
            org_id: ORG.into(),
            me: members.first().map(|m| m.0.to_owned()).unwrap_or_default(),
            umum: String::new(),
            members: members
                .iter()
                .map(|(pk, active, sa)| {
                    (
                        (*pk).to_owned(),
                        MemberInfo {
                            name: None,
                            active: *active,
                            guest: false,
                            superadmin: *sa,
                            removed_at: None,
                        },
                    )
                })
                .collect(),
            teams: Default::default(),
            log_channels: Default::default(),
        }
    }

    fn row(r: &ProfileRecord) -> RecordRow {
        r.row(&crate::network::feature::record_id(&r.to_body()))
    }

    #[test]
    fn body_round_trips_and_is_canonical() {
        let id = identity();
        let rec = set(&id, &hash(1), 1, AT);
        let body = rec.to_body();
        assert!(body.starts_with(r#"{"v":1,"kind":"set","org":""#), "{body}");
        assert_eq!(ProfileRecord::parse(&body).unwrap(), rec);
        let clear = ProfileRecord::sign_new(
            &id,
            RecordKind::Clear,
            ORG,
            id.public_key_hex(),
            None,
            None,
            2,
            AT,
        )
        .unwrap();
        let body = clear.to_body();
        assert!(body.contains(r#""photo":null,"size":null"#), "{body}");
        assert_eq!(ProfileRecord::parse(&body).unwrap(), clear);
    }

    #[test]
    fn signing_bytes_have_the_domain_and_an_empty_sig() {
        let id = identity();
        let rec = set(&id, &hash(1), 1, AT);
        let bytes = rec.signing_bytes();
        assert!(bytes.starts_with(b"mira/profile/v1\n{"));
        assert!(String::from_utf8(bytes).unwrap().ends_with(r#","sig":""}"#));
    }

    #[test]
    fn other_encodings_and_bad_signatures_are_refused() {
        let id = identity();
        let rec = set(&id, &hash(1), 1, AT);
        let body = rec.to_body();
        // Spaces.
        let spaced = body.replace(",\"kind\"", ", \"kind\"");
        assert!(ProfileRecord::parse(&spaced).is_err());
        // Field order.
        let value: serde_json::Value = serde_json::from_str(&body).unwrap();
        let mut map: Vec<(String, serde_json::Value)> =
            value.as_object().unwrap().clone().into_iter().collect();
        map.reverse();
        let reordered = format!(
            "{{{}}}",
            map.iter()
                .map(|(k, v)| format!("{}:{}", serde_json::to_string(k).unwrap(), v))
                .collect::<Vec<_>>()
                .join(",")
        );
        assert_ne!(reordered, body);
        assert!(ProfileRecord::parse(&reordered).is_err());
        // Extra field.
        let extra = body.replacen('{', r#"{"x":1,"#, 1);
        assert!(ProfileRecord::parse(&extra).is_err());
        let extra_end = format!("{},\"x\":1}}", &body[..body.len() - 1]);
        assert!(ProfileRecord::parse(&extra_end).is_err());
        // Signature of someone else, and a changed field.
        let other = identity();
        let mut forged = rec.clone();
        forged.sign_with(&other);
        assert!(ProfileRecord::parse(&forged.to_body()).is_err());
        let mut changed = rec.clone();
        changed.seq = 2;
        assert!(ProfileRecord::parse(&changed.to_body()).is_err());
        // Upper-case hex is another encoding of the same key.
        let mut upper = rec.clone();
        upper.photo = Some(hash(1).to_uppercase());
        assert!(ProfileRecord::parse(&upper.to_body()).is_err());
        // Non-canonical time.
        let mut time = rec.clone();
        time.at = "2026-11-24T08:00:00.000Z".into();
        time.sign_with(&id);
        assert!(ProfileRecord::parse(&time.to_body()).is_err());
    }

    #[test]
    fn kind_rules_are_enforced() {
        let id = identity();
        let me = id.public_key_hex().to_owned();
        let h = hash(1);
        let bad = [
            (RecordKind::Set, None, Some(10), 1),
            (RecordKind::Set, Some(h.as_str()), None, 1),
            (RecordKind::Set, Some(h.as_str()), Some(0), 1),
            (
                RecordKind::Set,
                Some(h.as_str()),
                Some(MAX_PHOTO_BYTES + 1),
                1,
            ),
            (RecordKind::Set, Some(h.as_str()), Some(10), 0),
            (RecordKind::Clear, Some(h.as_str()), None, 1),
            (RecordKind::Clear, None, Some(10), 1),
            (RecordKind::Clear, None, None, 0),
            (RecordKind::Remove, None, None, 0),
            (RecordKind::Remove, Some(h.as_str()), Some(10), 0),
            (RecordKind::Remove, Some(h.as_str()), None, 1),
        ];
        for (kind, photo, size, seq) in bad {
            assert!(
                ProfileRecord::sign_new(&id, kind, ORG, &me, photo, size, seq, AT).is_err(),
                "{kind:?} {photo:?} {size:?} {seq}"
            );
            // The same record signed by hand is refused by `parse`.
            let mut rec = ProfileRecord {
                v: 1,
                kind,
                org: ORG.into(),
                owner: me.clone(),
                author: me.clone(),
                photo: photo.map(str::to_owned),
                size,
                seq,
                at: AT.into(),
                sig: String::new(),
            };
            rec.sign_with(&id);
            assert!(ProfileRecord::parse(&rec.to_body()).is_err());
        }
        // `set` for someone else is refused even when signed correctly.
        let other = identity();
        assert!(
            ProfileRecord::sign_new(
                &id,
                RecordKind::Set,
                ORG,
                other.public_key_hex(),
                Some(&h),
                Some(10),
                1,
                AT
            )
            .is_err()
        );
        // `remove` of someone else's photo is fine in form.
        let rm = ProfileRecord::sign_new(
            &id,
            RecordKind::Remove,
            ORG,
            other.public_key_hex(),
            Some(&h),
            None,
            0,
            AT,
        )
        .unwrap();
        assert!(ProfileRecord::parse(&rm.to_body()).is_ok());
        // Wrong version.
        let mut v2 = set(&id, &h, 1, AT);
        v2.v = 2;
        v2.sign_with(&id);
        assert!(ProfileRecord::parse(&v2.to_body()).is_err());
    }

    #[test]
    fn check_against_the_organization() {
        let owner = identity();
        let sa = identity();
        let plain = identity();
        let o = owner.public_key_hex();
        let d = dir(&[
            (o, true, false),
            (sa.public_key_hex(), true, true),
            (plain.public_key_hex(), true, false),
        ]);
        let rec = set(&owner, &hash(1), 1, AT);
        assert_eq!(rec.check_against(&d), Ok(()));
        let mut other_org = rec.clone();
        other_org.org = "f".repeat(32);
        assert_eq!(other_org.check_against(&d).unwrap_err().code, "org");
        let stranger = identity();
        let theirs = set(&stranger, &hash(1), 1, AT);
        assert_eq!(theirs.check_against(&d).unwrap_err().code, "not_member");
        let rm = |by: &Identity| {
            ProfileRecord::sign_new(by, RecordKind::Remove, ORG, o, Some(&hash(1)), None, 0, AT)
                .unwrap()
        };
        assert_eq!(rm(&sa).check_against(&d), Ok(()));
        assert_eq!(
            rm(&plain).check_against(&d).unwrap_err().code,
            "not_superadmin"
        );
        // A removed owner still counts as known.
        let d2 = dir(&[(o, false, false), (sa.public_key_hex(), true, true)]);
        assert_eq!(rec.check_against(&d2), Ok(()));
    }

    #[test]
    fn latest_owner_record_wins_by_seq_then_at_then_id() {
        let a = identity();
        let pa = a.public_key_hex();
        let d = dir(&[(pa, true, false)]);
        let all = |_: &str| true;
        let r1 = set(&a, &hash(1), 1, "2026-11-24T09:00:00Z");
        let r2 = set(&a, &hash(2), 2, "2026-11-24T08:00:00Z");
        let rows = vec![row(&r2), row(&r1)];
        let st = &effective(&rows, &d, &all)[pa];
        assert_eq!(st.photo, Some(hash(2)), "higher seq wins over later time");
        assert_eq!(st.latest, Some(rows[0].id.clone()));
        // Same seq: later `at` wins.
        let r3 = set(&a, &hash(3), 2, "2026-11-24T10:00:00Z");
        let rows = vec![row(&r3), row(&r2), row(&r1)];
        assert_eq!(effective(&rows, &d, &all)[pa].photo, Some(hash(3)));
        // Same seq and `at`: the larger id wins, in any order.
        let r4 = set(&a, &hash(4), 2, "2026-11-24T10:00:00Z");
        let (lo, hi) = {
            let (x, y) = (row(&r3), row(&r4));
            if x.id < y.id { (x, y) } else { (y, x) }
        };
        for rows in [vec![lo.clone(), hi.clone()], vec![hi.clone(), lo.clone()]] {
            assert_eq!(effective(&rows, &d, &all)[pa].latest, Some(hi.id.clone()));
        }
        // A newer clear shows initials.
        let c = ProfileRecord::sign_new(&a, RecordKind::Clear, ORG, pa, None, None, 5, AT).unwrap();
        let rows = vec![row(&r1), row(&c)];
        let st = &effective(&rows, &d, &all)[pa];
        assert_eq!(st.photo, None);
        assert_eq!(st.wanted, None);
        assert!(!st.removed_by_admin);
        // A photo that is not here is wanted but not shown.
        let rows = vec![row(&r1)];
        let st = &effective(&rows, &d, &|_| false)[pa];
        assert_eq!(st.wanted, Some(hash(1)));
        assert_eq!(st.photo, None);
    }

    #[test]
    fn rows_signed_by_someone_else_never_count_as_the_owner() {
        let a = identity();
        let b = identity();
        let pa = a.public_key_hex();
        let d = dir(&[(pa, true, false), (b.public_key_hex(), true, false)]);
        let mine = set(&a, &hash(1), 1, AT);
        let mut fake = row(&set(&b, &hash(9), 9, AT));
        fake.owner = pa.to_owned();
        let rows = vec![row(&mine), fake];
        assert_eq!(effective(&rows, &d, &|_| true)[pa].photo, Some(hash(1)));
    }

    #[test]
    fn remove_by_an_active_superadmin_hides_that_hash_only() {
        let a = identity();
        let sa = identity();
        let plain = identity();
        let pa = a.public_key_hex();
        let psa = sa.public_key_hex();
        let all = |_: &str| true;
        let d = dir(&[
            (pa, true, false),
            (psa, true, true),
            (plain.public_key_hex(), true, false),
        ]);
        let r1 = set(&a, &hash(1), 1, AT);
        let rm = |by: &Identity, h: &str| {
            ProfileRecord::sign_new(by, RecordKind::Remove, ORG, pa, Some(h), None, 0, AT).unwrap()
        };
        let rows = vec![row(&r1), row(&rm(&sa, &hash(1)))];
        let st = &effective(&rows, &d, &all)[pa];
        assert_eq!(st.photo, None);
        assert_eq!(st.wanted, None);
        assert!(st.removed_by_admin);
        assert_eq!(st.removes.len(), 1);
        // A remove by a plain member (stored by mistake) does nothing.
        let rows = vec![row(&r1), row(&rm(&plain, &hash(1)))];
        let st = &effective(&rows, &d, &all)[pa];
        assert_eq!(st.photo, Some(hash(1)));
        assert!(st.removes.is_empty());
        // A superadmin who is not one any more: the remove stops counting.
        let demoted = dir(&[(pa, true, false), (psa, true, false)]);
        let rows = vec![row(&r1), row(&rm(&sa, &hash(1)))];
        assert_eq!(effective(&rows, &demoted, &all)[pa].photo, Some(hash(1)));
        // The owner sets another photo afterwards: shown.
        let r2 = set(&a, &hash(2), 2, AT);
        let rows = vec![row(&r1), row(&rm(&sa, &hash(1))), row(&r2)];
        let st = &effective(&rows, &d, &all)[pa];
        assert_eq!(st.photo, Some(hash(2)));
        assert!(!st.removed_by_admin);
    }
}
