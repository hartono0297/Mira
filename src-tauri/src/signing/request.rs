//! Model murni permintaan tanda tangan: siapa boleh meminta, siapa boleh
//! menandatangani dan kapan, serta status permintaan. Tanpa DB dan tanpa I/O;
//! `repo.rs` menyimpan, `service.rs` menjalankan alurnya.
//!
//! Aturan:
//! - Pengirim menentukan urutan: berurutan (`Sequential`, hanya penanda tangan
//!   pertama yang belum yang boleh) atau bebas (`Parallel`, siapa pun yang
//!   belum).
//! - Tamu tidak bisa meminta tanda tangan, tetapi boleh menandatangani kalau
//!   dimasukkan ke daftar penanda tangan.
//!
//! Titik sambung Tahap 4: Tamu hanya boleh menyentuh dokumen di proyek yang
//! diizinkan untuknya. Pembatasan itu disambung di sini (atau di `service.rs`)
//! setelah dokumen punya proyek; sekarang permintaan belum terikat proyek.

use serde::{Deserialize, Serialize};

use super::err;
use crate::error::{AppError, AppResult};
use crate::identity::has_forbidden_chars;

pub const TITLE_MAX_CHARS: usize = 200;
pub const MAX_SIGNERS: usize = 20;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SignMode {
    Sequential,
    Parallel,
}

impl SignMode {
    pub fn as_str(self) -> &'static str {
        match self {
            SignMode::Sequential => "sequential",
            SignMode::Parallel => "parallel",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "sequential" => Some(SignMode::Sequential),
            "parallel" => Some(SignMode::Parallel),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SignerKind {
    Member,
    Guest,
}

impl SignerKind {
    pub fn as_str(self) -> &'static str {
        match self {
            SignerKind::Member => "member",
            SignerKind::Guest => "guest",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "member" => Some(SignerKind::Member),
            "guest" => Some(SignerKind::Guest),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SignerStatus {
    Waiting,
    Signed,
}

impl SignerStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            SignerStatus::Waiting => "waiting",
            SignerStatus::Signed => "signed",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "waiting" => Some(SignerStatus::Waiting),
            "signed" => Some(SignerStatus::Signed),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RequestStatus {
    InProgress,
    Completed,
    Cancelled,
}

impl RequestStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            RequestStatus::InProgress => "in_progress",
            RequestStatus::Completed => "completed",
            RequestStatus::Cancelled => "cancelled",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "in_progress" => Some(RequestStatus::InProgress),
            "completed" => Some(RequestStatus::Completed),
            "cancelled" => Some(RequestStatus::Cancelled),
            _ => None,
        }
    }
}

/// Posisi satu laptop terhadap satu permintaan, untuk daftar di layar.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MyState {
    YourTurn,
    WaitingOthers,
    Signed,
    NotInvolved,
}

impl MyState {
    pub fn as_str(self) -> &'static str {
        match self {
            MyState::YourTurn => "your_turn",
            MyState::WaitingOthers => "waiting_others",
            MyState::Signed => "signed",
            MyState::NotInvolved => "not_involved",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "your_turn" => Some(MyState::YourTurn),
            "waiting_others" => Some(MyState::WaitingOthers),
            "signed" => Some(MyState::Signed),
            "not_involved" => Some(MyState::NotInvolved),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Signer {
    pub position: u32,
    pub public_key: String,
    pub display_name: String,
    pub kind: SignerKind,
    pub status: SignerStatus,
    pub signed_at: Option<String>,
    pub hash_after: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignRequest {
    pub id: String,
    pub title: String,
    pub requested_by: String,
    pub mode: SignMode,
    pub status: RequestStatus,
    pub original_hash: String,
    pub current_hash: String,
    pub created_at: String,
    pub updated_at: String,
    pub completed_at: Option<String>,
    /// Urut menurut `position` (0, 1, 2, ...).
    pub signers: Vec<Signer>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignerInput {
    pub public_key: String,
    pub display_name: String,
    pub kind: SignerKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewRequest {
    pub title: String,
    pub mode: SignMode,
    /// Urutan di sini menjadi urutan tanda tangan untuk mode berurutan.
    pub signers: Vec<SignerInput>,
}

/// Laptop yang membuat permintaan, dilihat dari daftar anggota organisasi.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Requester {
    pub public_key: String,
    pub kind: SignerKind,
    /// `false` kalau laptop ini sudah dikeluarkan dari organisasi.
    pub active: bool,
}

fn invalid(message: impl Into<String>) -> AppError {
    err("request_invalid", message)
}

fn is_public_key_hex(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// Memeriksa permintaan baru sebelum disimpan.
pub fn validate_new(requester: &Requester, new: &NewRequest) -> AppResult<()> {
    if !requester.active {
        return Err(AppError::Removed);
    }
    if requester.kind == SignerKind::Guest {
        return Err(err(
            "guest_cannot_request",
            "Tamu tidak bisa meminta tanda tangan. Minta anggota tim untuk mengirim permintaan.",
        ));
    }

    let title = new.title.trim();
    if title.is_empty() {
        return Err(invalid("Isi judul permintaan tanda tangan dulu."));
    }
    if title.chars().count() > TITLE_MAX_CHARS {
        return Err(invalid(format!(
            "Judul permintaan terlalu panjang. Maksimal {TITLE_MAX_CHARS} karakter."
        )));
    }
    if has_forbidden_chars(title) {
        return Err(invalid(
            "Judul permintaan berisi karakter yang tidak diizinkan, misalnya baris baru atau tab.",
        ));
    }

    if new.signers.is_empty() {
        return Err(invalid("Pilih minimal satu penanda tangan."));
    }
    if new.signers.len() > MAX_SIGNERS {
        return Err(invalid(format!(
            "Penanda tangan terlalu banyak. Maksimal {MAX_SIGNERS} orang per permintaan."
        )));
    }

    for (i, signer) in new.signers.iter().enumerate() {
        let number = i + 1;
        if !is_public_key_hex(&signer.public_key) {
            return Err(invalid(format!(
                "Kunci publik penanda tangan ke-{number} tidak valid. Kunci harus 64 karakter hex huruf kecil."
            )));
        }
        let name = signer.display_name.trim();
        if name.is_empty() {
            return Err(invalid(format!(
                "Nama tampilan penanda tangan ke-{number} kosong."
            )));
        }
        if has_forbidden_chars(name) {
            return Err(invalid(format!(
                "Nama tampilan penanda tangan ke-{number} berisi karakter yang tidak diizinkan."
            )));
        }
        if new.signers[..i]
            .iter()
            .any(|s| s.public_key == signer.public_key)
        {
            return Err(invalid(format!(
                "{name} tercantum lebih dari sekali di daftar penanda tangan."
            )));
        }
    }
    Ok(())
}

impl SignRequest {
    /// Membuat permintaan dari masukan yang sudah lolos `validate_new`.
    pub fn new(
        id: String,
        new: NewRequest,
        requested_by: String,
        original_hash: String,
        now: &str,
    ) -> SignRequest {
        let signers = new
            .signers
            .into_iter()
            .enumerate()
            .map(|(i, s)| Signer {
                position: i as u32,
                public_key: s.public_key,
                display_name: s.display_name.trim().to_owned(),
                kind: s.kind,
                status: SignerStatus::Waiting,
                signed_at: None,
                hash_after: None,
            })
            .collect();
        SignRequest {
            id,
            title: new.title.trim().to_owned(),
            requested_by,
            mode: new.mode,
            status: RequestStatus::InProgress,
            current_hash: original_hash.clone(),
            original_hash,
            created_at: now.to_owned(),
            updated_at: now.to_owned(),
            completed_at: None,
            signers,
        }
    }

    fn signer_index(&self, pk: &str) -> Option<usize> {
        self.signers.iter().position(|s| s.public_key == pk)
    }

    /// Indeks penanda tangan `pk` kalau dia boleh menandatangani sekarang.
    pub fn can_sign(&self, pk: &str) -> AppResult<usize> {
        match self.status {
            RequestStatus::InProgress => {}
            RequestStatus::Completed => {
                return Err(err(
                    "request_closed",
                    "Permintaan ini sudah selesai ditandatangani semua orang.",
                ));
            }
            RequestStatus::Cancelled => {
                return Err(err(
                    "request_closed",
                    "Permintaan ini sudah dibatalkan pengirimnya.",
                ));
            }
        }
        let Some(index) = self.signer_index(pk) else {
            return Err(err(
                "not_a_signer",
                "Anda tidak ada di daftar penanda tangan permintaan ini.",
            ));
        };
        if self.signers[index].status == SignerStatus::Signed {
            return Err(err(
                "already_signed",
                "Anda sudah menandatangani dokumen ini.",
            ));
        }
        if self.mode == SignMode::Sequential
            && let Some(current) = self.signers[..index]
                .iter()
                .find(|s| s.status == SignerStatus::Waiting)
        {
            return Err(err(
                "not_your_turn",
                format!(
                    "Belum giliran Anda. Sekarang giliran {} menandatangani.",
                    current.display_name
                ),
            ));
        }
        Ok(index)
    }

    /// Mencatat tanda tangan `pk`. Permintaan selesai saat semua sudah.
    pub fn record_signature(&mut self, pk: &str, at: &str, hash_after: &str) -> AppResult<()> {
        let index = self.can_sign(pk)?;
        let signer = &mut self.signers[index];
        signer.status = SignerStatus::Signed;
        signer.signed_at = Some(at.to_owned());
        signer.hash_after = Some(hash_after.to_owned());
        self.current_hash = hash_after.to_owned();
        self.updated_at = at.to_owned();
        if self
            .signers
            .iter()
            .all(|s| s.status == SignerStatus::Signed)
        {
            self.status = RequestStatus::Completed;
            self.completed_at = Some(at.to_owned());
        }
        Ok(())
    }

    /// Membatalkan permintaan. Hanya pengirim, dan hanya selama berjalan.
    pub fn cancel(&mut self, by: &str, at: &str) -> AppResult<()> {
        if by != self.requested_by {
            return Err(err(
                "not_requester",
                "Hanya pengirim permintaan yang bisa membatalkannya.",
            ));
        }
        match self.status {
            RequestStatus::InProgress => {}
            RequestStatus::Completed => {
                return Err(err(
                    "request_closed",
                    "Permintaan ini sudah selesai, jadi tidak bisa dibatalkan.",
                ));
            }
            RequestStatus::Cancelled => {
                return Err(err("request_closed", "Permintaan ini sudah dibatalkan."));
            }
        }
        self.status = RequestStatus::Cancelled;
        self.updated_at = at.to_owned();
        Ok(())
    }

    /// Penanda tangan yang boleh menandatangani sekarang.
    pub fn next_signers(&self) -> Vec<&Signer> {
        if self.status != RequestStatus::InProgress {
            return Vec::new();
        }
        let mut waiting = self
            .signers
            .iter()
            .filter(|s| s.status == SignerStatus::Waiting);
        match self.mode {
            SignMode::Sequential => waiting.next().into_iter().collect(),
            SignMode::Parallel => waiting.collect(),
        }
    }

    /// `true` kalau `pk` satu-satunya yang belum dan boleh menandatangani
    /// sekarang (dia yang menambahkan halaman catatan di akhir dokumen).
    pub fn is_last_pending(&self, pk: &str) -> bool {
        self.can_sign(pk).is_ok()
            && self
                .signers
                .iter()
                .filter(|s| s.status == SignerStatus::Waiting)
                .count()
                == 1
    }

    pub fn my_state(&self, pk: &str) -> MyState {
        if self.can_sign(pk).is_ok() {
            return MyState::YourTurn;
        }
        let in_progress = self.status == RequestStatus::InProgress;
        match self.signer_index(pk).map(|i| self.signers[i].status) {
            Some(SignerStatus::Signed) => MyState::Signed,
            Some(SignerStatus::Waiting) if in_progress => MyState::WaitingOthers,
            Some(SignerStatus::Waiting) => MyState::NotInvolved,
            None if in_progress && pk == self.requested_by => MyState::WaitingOthers,
            None => MyState::NotInvolved,
        }
    }

    pub fn signed_count(&self) -> usize {
        self.signers
            .iter()
            .filter(|s| s.status == SignerStatus::Signed)
            .count()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    const NOW: &str = "2026-11-22T08:00:00Z";
    const LATER: &str = "2026-11-22T09:00:00Z";

    fn key(i: usize) -> String {
        format!("{:064x}", i + 1)
    }

    fn hash(i: usize) -> String {
        format!("{:064x}", 0xabc000 + i)
    }

    fn requester_key() -> String {
        "f".repeat(64)
    }

    fn member() -> Requester {
        Requester {
            public_key: requester_key(),
            kind: SignerKind::Member,
            active: true,
        }
    }

    fn input(i: usize, kind: SignerKind) -> SignerInput {
        SignerInput {
            public_key: key(i),
            display_name: format!("Orang {i}"),
            kind,
        }
    }

    fn new_req(mode: SignMode, n: usize) -> NewRequest {
        NewRequest {
            title: "Kontrak sewa".into(),
            mode,
            signers: (0..n).map(|i| input(i, SignerKind::Member)).collect(),
        }
    }

    fn build(new: NewRequest) -> SignRequest {
        SignRequest::new("a".repeat(32), new, requester_key(), hash(0), NOW)
    }

    fn request(mode: SignMode, n: usize) -> SignRequest {
        build(new_req(mode, n))
    }

    fn code(r: AppResult<impl std::fmt::Debug>) -> &'static str {
        r.expect_err("harus error").code()
    }

    #[test]
    fn enums_round_trip_db_strings_and_serde() {
        for m in [SignMode::Sequential, SignMode::Parallel] {
            assert_eq!(SignMode::parse(m.as_str()), Some(m));
            assert_eq!(serde_json::to_value(m).unwrap(), m.as_str());
        }
        for k in [SignerKind::Member, SignerKind::Guest] {
            assert_eq!(SignerKind::parse(k.as_str()), Some(k));
            assert_eq!(serde_json::to_value(k).unwrap(), k.as_str());
        }
        for s in [SignerStatus::Waiting, SignerStatus::Signed] {
            assert_eq!(SignerStatus::parse(s.as_str()), Some(s));
            assert_eq!(serde_json::to_value(s).unwrap(), s.as_str());
        }
        for s in [
            RequestStatus::InProgress,
            RequestStatus::Completed,
            RequestStatus::Cancelled,
        ] {
            assert_eq!(RequestStatus::parse(s.as_str()), Some(s));
            assert_eq!(serde_json::to_value(s).unwrap(), s.as_str());
        }
        for s in [
            MyState::YourTurn,
            MyState::WaitingOthers,
            MyState::Signed,
            MyState::NotInvolved,
        ] {
            assert_eq!(MyState::parse(s.as_str()), Some(s));
            assert_eq!(serde_json::to_value(s).unwrap(), s.as_str());
        }
        assert_eq!(RequestStatus::InProgress.as_str(), "in_progress");
        assert_eq!(SignMode::parse("Sequential"), None);
        assert_eq!(SignerKind::parse(""), None);
        assert_eq!(SignerStatus::parse("done"), None);
        assert_eq!(RequestStatus::parse("canceled"), None);
        assert_eq!(MyState::parse("yourturn"), None);
    }

    #[test]
    fn validate_accepts_valid_request() {
        assert!(validate_new(&member(), &new_req(SignMode::Sequential, 3)).is_ok());
    }

    #[test]
    fn validate_rejects_removed_requester() {
        let mut r = member();
        r.active = false;
        assert_eq!(
            validate_new(&r, &new_req(SignMode::Parallel, 1)),
            Err(AppError::Removed)
        );
    }

    #[test]
    fn guest_cannot_request() {
        let r = Requester {
            kind: SignerKind::Guest,
            ..member()
        };
        let e = validate_new(&r, &new_req(SignMode::Parallel, 1)).unwrap_err();
        assert_eq!(e.code(), "guest_cannot_request");
        assert_eq!(
            e.to_string(),
            "Tamu tidak bisa meminta tanda tangan. Minta anggota tim untuk mengirim permintaan."
        );
    }

    #[test]
    fn validate_title_rules() {
        let mut n = new_req(SignMode::Parallel, 1);
        for bad in ["", "   ", "Judul\nbaru", "Judul\u{200B}", "a\tb"] {
            n.title = bad.into();
            assert_eq!(
                code(validate_new(&member(), &n)),
                "request_invalid",
                "{bad:?}"
            );
        }
        n.title = "é".repeat(TITLE_MAX_CHARS);
        assert!(validate_new(&member(), &n).is_ok());
        n.title = format!("  {}  ", "x".repeat(TITLE_MAX_CHARS));
        assert!(validate_new(&member(), &n).is_ok());
        n.title = "x".repeat(TITLE_MAX_CHARS + 1);
        let e = validate_new(&member(), &n).unwrap_err();
        assert_eq!(e.code(), "request_invalid");
        assert!(e.to_string().contains("200"));
    }

    #[test]
    fn validate_signer_count() {
        assert_eq!(
            code(validate_new(&member(), &new_req(SignMode::Parallel, 0))),
            "request_invalid"
        );
        assert!(validate_new(&member(), &new_req(SignMode::Parallel, MAX_SIGNERS)).is_ok());
        assert_eq!(
            code(validate_new(
                &member(),
                &new_req(SignMode::Parallel, MAX_SIGNERS + 1)
            )),
            "request_invalid"
        );
    }

    #[test]
    fn validate_public_keys() {
        let mut n = new_req(SignMode::Parallel, 2);
        for bad in [
            "A".repeat(64),
            "a".repeat(63),
            "a".repeat(65),
            "g".repeat(64),
            String::new(),
        ] {
            n.signers[1].public_key = bad.clone();
            let e = validate_new(&member(), &n).unwrap_err();
            assert_eq!(e.code(), "request_invalid", "{bad:?}");
            assert!(e.to_string().contains("ke-2"));
        }
    }

    #[test]
    fn validate_rejects_duplicate_signer() {
        let mut n = new_req(SignMode::Parallel, 3);
        n.signers[2].public_key = key(0);
        let e = validate_new(&member(), &n).unwrap_err();
        assert_eq!(e.code(), "request_invalid");
        assert!(e.to_string().contains("lebih dari sekali"));
    }

    #[test]
    fn validate_display_name() {
        let mut n = new_req(SignMode::Parallel, 1);
        for bad in ["", "   ", "Nama\nBaru"] {
            n.signers[0].display_name = bad.into();
            assert_eq!(
                code(validate_new(&member(), &n)),
                "request_invalid",
                "{bad:?}"
            );
        }
    }

    #[test]
    fn new_request_initial_state() {
        let mut n = new_req(SignMode::Sequential, 3);
        n.title = "  Kontrak sewa  ".into();
        n.signers[1].display_name = " Budi ".into();
        let r = build(n);
        assert_eq!(r.title, "Kontrak sewa");
        assert_eq!(r.status, RequestStatus::InProgress);
        assert_eq!(r.current_hash, r.original_hash);
        assert_eq!(r.created_at, NOW);
        assert_eq!(r.updated_at, NOW);
        assert_eq!(r.completed_at, None);
        assert_eq!(r.requested_by, requester_key());
        assert_eq!(r.signers[1].display_name, "Budi");
        for (i, s) in r.signers.iter().enumerate() {
            assert_eq!(s.position, i as u32);
            assert_eq!(s.public_key, key(i));
            assert_eq!(s.status, SignerStatus::Waiting);
            assert_eq!(s.signed_at, None);
            assert_eq!(s.hash_after, None);
        }
        assert_eq!(r.signed_count(), 0);
    }

    #[test]
    fn sequential_rejects_skipping_and_names_current_signer() {
        let r = request(SignMode::Sequential, 3);
        assert_eq!(r.can_sign(&key(0)), Ok(0));
        let e = r.can_sign(&key(2)).unwrap_err();
        assert_eq!(e.code(), "not_your_turn");
        assert!(e.to_string().contains("Orang 0"), "{e}");
        assert_eq!(r.next_signers().len(), 1);
        assert_eq!(r.next_signers()[0].public_key, key(0));
    }

    #[test]
    fn sequential_full_flow_completes_after_last() {
        let mut r = request(SignMode::Sequential, 3);
        r.record_signature(&key(0), "t1", &hash(1)).unwrap();
        let e = r.can_sign(&key(2)).unwrap_err();
        assert!(e.to_string().contains("Orang 1"));
        r.record_signature(&key(1), "t2", &hash(2)).unwrap();
        assert_eq!(r.status, RequestStatus::InProgress);
        assert!(r.is_last_pending(&key(2)));
        r.record_signature(&key(2), "t3", &hash(3)).unwrap();
        assert_eq!(r.status, RequestStatus::Completed);
        assert_eq!(r.completed_at.as_deref(), Some("t3"));
        assert_eq!(r.updated_at, "t3");
        assert_eq!(r.current_hash, hash(3));
        assert_eq!(r.original_hash, hash(0));
        assert_eq!(r.signers[1].signed_at.as_deref(), Some("t2"));
        assert_eq!(r.signers[1].hash_after, Some(hash(2)));
        assert_eq!(r.signed_count(), 3);
        assert!(r.next_signers().is_empty());
    }

    #[test]
    fn parallel_accepts_any_order() {
        let mut r = request(SignMode::Parallel, 3);
        assert_eq!(r.next_signers().len(), 3);
        r.record_signature(&key(2), "t1", &hash(1)).unwrap();
        r.record_signature(&key(0), "t2", &hash(2)).unwrap();
        assert_eq!(r.next_signers().len(), 1);
        assert_eq!(r.next_signers()[0].public_key, key(1));
        r.record_signature(&key(1), "t3", &hash(3)).unwrap();
        assert_eq!(r.status, RequestStatus::Completed);
    }

    #[test]
    fn not_a_signer_and_already_signed() {
        let mut r = request(SignMode::Parallel, 2);
        assert_eq!(code(r.can_sign(&key(9))), "not_a_signer");
        assert_eq!(code(r.can_sign(&requester_key())), "not_a_signer");
        r.record_signature(&key(0), "t1", &hash(1)).unwrap();
        assert_eq!(code(r.can_sign(&key(0))), "already_signed");
        assert_eq!(
            code(r.record_signature(&key(0), "t2", &hash(2))),
            "already_signed"
        );
        assert_eq!(r.current_hash, hash(1));
        assert_eq!(r.updated_at, "t1");
    }

    #[test]
    fn cannot_sign_after_completed() {
        let mut r = request(SignMode::Parallel, 1);
        r.record_signature(&key(0), "t1", &hash(1)).unwrap();
        assert_eq!(code(r.can_sign(&key(0))), "request_closed");
        assert_eq!(code(r.can_sign(&key(5))), "request_closed");
    }

    #[test]
    fn cannot_sign_after_cancelled() {
        let mut r = request(SignMode::Parallel, 2);
        r.cancel(&requester_key(), LATER).unwrap();
        assert_eq!(r.status, RequestStatus::Cancelled);
        assert_eq!(r.updated_at, LATER);
        assert_eq!(r.completed_at, None);
        assert_eq!(code(r.can_sign(&key(0))), "request_closed");
        assert_eq!(
            code(r.record_signature(&key(0), "t", &hash(1))),
            "request_closed"
        );
        assert!(r.next_signers().is_empty());
    }

    #[test]
    fn cancel_rules() {
        let mut r = request(SignMode::Sequential, 2);
        assert_eq!(code(r.cancel(&key(0), LATER)), "not_requester");
        assert_eq!(r.status, RequestStatus::InProgress);
        r.cancel(&requester_key(), LATER).unwrap();
        assert_eq!(code(r.cancel(&requester_key(), LATER)), "request_closed");

        let mut done = request(SignMode::Sequential, 1);
        done.record_signature(&key(0), "t1", &hash(1)).unwrap();
        assert_eq!(code(done.cancel(&requester_key(), LATER)), "request_closed");
        assert_eq!(done.status, RequestStatus::Completed);
    }

    #[test]
    fn guest_signer_can_sign() {
        let mut n = new_req(SignMode::Sequential, 1);
        n.signers.push(input(1, SignerKind::Guest));
        assert!(validate_new(&member(), &n).is_ok());
        let mut r = build(n);
        r.record_signature(&key(0), "t1", &hash(1)).unwrap();
        assert_eq!(r.signers[1].kind, SignerKind::Guest);
        assert_eq!(r.my_state(&key(1)), MyState::YourTurn);
        r.record_signature(&key(1), "t2", &hash(2)).unwrap();
        assert_eq!(r.status, RequestStatus::Completed);
    }

    #[test]
    fn is_last_pending_cases() {
        let mut r = request(SignMode::Parallel, 2);
        assert!(!r.is_last_pending(&key(0)));
        r.record_signature(&key(0), "t1", &hash(1)).unwrap();
        assert!(r.is_last_pending(&key(1)));
        assert!(!r.is_last_pending(&key(0)));
        assert!(!r.is_last_pending(&key(9)));

        let mut seq = request(SignMode::Sequential, 2);
        assert!(!seq.is_last_pending(&key(1)));
        seq.cancel(&requester_key(), LATER).unwrap();
        assert!(!seq.is_last_pending(&key(0)));
    }

    #[test]
    fn my_state_in_progress_sequential() {
        let mut r = request(SignMode::Sequential, 3);
        r.record_signature(&key(0), "t1", &hash(1)).unwrap();
        assert_eq!(r.my_state(&key(0)), MyState::Signed);
        assert_eq!(r.my_state(&key(1)), MyState::YourTurn);
        assert_eq!(r.my_state(&key(2)), MyState::WaitingOthers);
        assert_eq!(r.my_state(&requester_key()), MyState::WaitingOthers);
        assert_eq!(r.my_state(&key(9)), MyState::NotInvolved);
    }

    #[test]
    fn my_state_requester_who_is_also_signer() {
        let mut n = new_req(SignMode::Sequential, 1);
        n.signers.push(SignerInput {
            public_key: requester_key(),
            display_name: "Pengirim".into(),
            kind: SignerKind::Member,
        });
        let mut r = build(n);
        assert_eq!(r.my_state(&requester_key()), MyState::WaitingOthers);
        r.record_signature(&key(0), "t1", &hash(1)).unwrap();
        assert_eq!(r.my_state(&requester_key()), MyState::YourTurn);
        r.record_signature(&requester_key(), "t2", &hash(2))
            .unwrap();
        assert_eq!(r.my_state(&requester_key()), MyState::Signed);
    }

    #[test]
    fn my_state_parallel() {
        let mut r = request(SignMode::Parallel, 2);
        assert_eq!(r.my_state(&key(0)), MyState::YourTurn);
        assert_eq!(r.my_state(&key(1)), MyState::YourTurn);
        r.record_signature(&key(1), "t1", &hash(1)).unwrap();
        assert_eq!(r.my_state(&key(1)), MyState::Signed);
        assert_eq!(r.my_state(&key(0)), MyState::YourTurn);
    }

    #[test]
    fn my_state_completed() {
        let mut r = request(SignMode::Parallel, 2);
        r.record_signature(&key(0), "t1", &hash(1)).unwrap();
        r.record_signature(&key(1), "t2", &hash(2)).unwrap();
        assert_eq!(r.my_state(&key(0)), MyState::Signed);
        assert_eq!(r.my_state(&key(1)), MyState::Signed);
        assert_eq!(r.my_state(&requester_key()), MyState::NotInvolved);
        assert_eq!(r.my_state(&key(9)), MyState::NotInvolved);
    }

    #[test]
    fn my_state_cancelled() {
        let mut r = request(SignMode::Sequential, 3);
        r.record_signature(&key(0), "t1", &hash(1)).unwrap();
        r.cancel(&requester_key(), LATER).unwrap();
        assert_eq!(r.my_state(&key(0)), MyState::Signed);
        assert_eq!(r.my_state(&key(1)), MyState::NotInvolved);
        assert_eq!(r.my_state(&key(2)), MyState::NotInvolved);
        assert_eq!(r.my_state(&requester_key()), MyState::NotInvolved);
        assert_eq!(r.my_state(&key(9)), MyState::NotInvolved);
    }

    #[test]
    fn serializes_camel_case() {
        let r = request(SignMode::Sequential, 1);
        let json = serde_json::to_value(&r).unwrap();
        assert_eq!(json["requestedBy"], requester_key());
        assert_eq!(json["mode"], "sequential");
        assert_eq!(json["status"], "in_progress");
        assert_eq!(json["signers"][0]["publicKey"], key(0));
        assert_eq!(json["signers"][0]["status"], "waiting");
        assert!(json["completedAt"].is_null());
    }

    fn mode_strategy() -> impl Strategy<Value = SignMode> {
        prop_oneof![Just(SignMode::Sequential), Just(SignMode::Parallel)]
    }

    proptest! {
        /// Percobaan acak (indeks `n` = orang di luar daftar) dibandingkan
        /// dengan model sederhana berupa daftar sudah/belum.
        #[test]
        fn random_attempts_follow_rules(
            mode in mode_strategy(),
            (n, attempts) in (1usize..8).prop_flat_map(|n| {
                (Just(n), prop::collection::vec(0..=n, 0..40))
            }),
        ) {
            let mut r = request(mode, n);
            let mut signed = vec![false; n];
            let mut last_count = 0;
            for (step, who) in attempts.into_iter().enumerate() {
                let all_before = signed.iter().all(|&s| s);
                let expected = who < n
                    && !all_before
                    && !signed[who]
                    && match mode {
                        SignMode::Sequential => signed.iter().position(|&s| !s) == Some(who),
                        SignMode::Parallel => true,
                    };
                let result = r.record_signature(&key(who), &format!("t{step}"), &hash(step + 1));
                prop_assert_eq!(result.is_ok(), expected, "mode {:?} who {} signed {:?}", mode, who, &signed);
                if expected {
                    signed[who] = true;
                    prop_assert_eq!(&r.current_hash, &hash(step + 1));
                }

                let all_signed = r.signers.iter().all(|s| s.status == SignerStatus::Signed);
                prop_assert_eq!(r.status == RequestStatus::Completed, all_signed);
                prop_assert_eq!(all_signed, signed.iter().all(|&s| s));

                let count = r.signed_count();
                prop_assert!(count >= last_count);
                prop_assert!(count <= n);
                prop_assert_eq!(count, signed.iter().filter(|&&s| s).count());
                last_count = count;
            }
        }
    }
}
