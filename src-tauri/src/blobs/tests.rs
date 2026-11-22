use std::fs;
use std::io::Read;
use std::path::Path;
use std::sync::Arc;

use super::*;

const EMPTY_HASH: &str = "af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262";
const ABC_HASH: &str = "6437b3ac38465133ffb63b75273a8db548c558465d79db03fd359c6cd5bd9d85";

fn store() -> (tempfile::TempDir, BlobStore) {
    let dir = tempfile::tempdir().unwrap();
    let store = BlobStore::in_data_dir(dir.path()).unwrap();
    (dir, store)
}

/// Deterministic, non-repeating-looking test data.
fn pattern(len: usize) -> Vec<u8> {
    let mut x: u32 = 0x1234_5678;
    (0..len)
        .map(|_| {
            x ^= x << 13;
            x ^= x >> 17;
            x ^= x << 5;
            (x >> 24) as u8
        })
        .collect()
}

/// Every blob file under `root`, outside `tmp/`.
fn blob_files(root: &Path) -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    for entry in fs::read_dir(root).unwrap() {
        let entry = entry.unwrap();
        if entry.file_name() == TMP_DIR_NAME || !entry.file_type().unwrap().is_dir() {
            continue;
        }
        for file in fs::read_dir(entry.path()).unwrap() {
            out.push(file.unwrap().path());
        }
    }
    out
}

fn tmp_entries(store: &BlobStore) -> usize {
    fs::read_dir(store.root().join(TMP_DIR_NAME))
        .unwrap()
        .count()
}

fn make_writable(path: &Path) {
    set_writable(path).unwrap();
}

#[test]
fn auto_replicate_threshold_is_inclusive() {
    assert!(should_auto_replicate(0));
    assert!(should_auto_replicate(AUTO_REPLICATE_MAX_BYTES));
    assert!(!should_auto_replicate(AUTO_REPLICATE_MAX_BYTES + 1));
}

#[test]
fn known_blake3_vectors() {
    assert_eq!(BlobHash::of_bytes(b"").as_str(), EMPTY_HASH);
    assert_eq!(BlobHash::of_bytes(b"abc").as_str(), ABC_HASH);
    let (_dir, store) = store();
    assert_eq!(store.put_bytes(b"").unwrap().hash.as_str(), EMPTY_HASH);
    assert_eq!(store.put_bytes(b"abc").unwrap().hash.as_str(), ABC_HASH);
}

#[test]
fn parse_accepts_only_64_lowercase_hex() {
    assert_eq!(BlobHash::parse(ABC_HASH).unwrap().as_str(), ABC_HASH);
    let upper = ABC_HASH.to_uppercase();
    let bad = [
        "",
        "abc",
        &ABC_HASH[..63],
        &format!("{ABC_HASH}0"),
        upper.as_str(),
        &format!("g{}", &ABC_HASH[1..]),
        &format!(" {}", &ABC_HASH[1..]),
        &format!("{}/", &ABC_HASH[..63]),
        &format!("..{}", &ABC_HASH[2..]),
    ];
    for s in bad {
        let err = BlobHash::parse(s).unwrap_err();
        assert_eq!(err.code(), "invalid_input", "{s:?}");
        assert!(!err.to_string().contains('\u{2014}'));
    }
    // Multi-byte characters must not slip through a byte-length check.
    let wide = format!("é{}", &ABC_HASH[..62]);
    assert_eq!(wide.len(), 64);
    assert!(BlobHash::parse(&wide).is_err());
}

#[test]
fn hash_serde_round_trip_and_invalid_string_fails() {
    let hash = BlobHash::parse(ABC_HASH).unwrap();
    let json = serde_json::to_string(&hash).unwrap();
    assert_eq!(json, format!("\"{ABC_HASH}\""));
    let back: BlobHash = serde_json::from_str(&json).unwrap();
    assert_eq!(back, hash);
    assert!(serde_json::from_str::<BlobHash>("\"not-a-hash\"").is_err());
    assert!(serde_json::from_str::<BlobHash>(&format!("\"{}\"", ABC_HASH.to_uppercase())).is_err());

    let info = BlobInfo { hash, size: 3 };
    let value = serde_json::to_value(&info).unwrap();
    assert_eq!(value["hash"], ABC_HASH);
    assert_eq!(value["size"], 3);
}

#[test]
fn put_bytes_then_read_back() {
    let (_dir, store) = store();
    let info = store.put_bytes(b"halo dunia").unwrap();
    assert_eq!(info.size, 10);
    assert_eq!(info.hash, BlobHash::of_bytes(b"halo dunia"));
    assert!(store.contains(&info.hash));
    assert_eq!(store.size(&info.hash).unwrap(), 10);
    assert_eq!(store.read_all(&info.hash).unwrap(), b"halo dunia");

    let mut s = String::new();
    store
        .open_read(&info.hash)
        .unwrap()
        .read_to_string(&mut s)
        .unwrap();
    assert_eq!(s, "halo dunia");

    let hex = info.hash.as_str();
    assert_eq!(
        store.path_of(&info.hash),
        store.root().join(&hex[..2]).join(hex)
    );
    assert!(store.path_of(&info.hash).is_file());
    assert_eq!(tmp_entries(&store), 0);
}

#[test]
fn round_trip_across_buffer_boundaries() {
    let (_dir, store) = store();
    for len in [
        0,
        1,
        COPY_BUF_BYTES - 1,
        COPY_BUF_BYTES,
        COPY_BUF_BYTES + 1,
        3 * COPY_BUF_BYTES + 7,
    ] {
        let data = pattern(len);
        let info = store.put_bytes(&data).unwrap();
        assert_eq!(info.size, len as u64);
        assert_eq!(info.hash, BlobHash::of_bytes(&data));
        assert_eq!(store.read_all(&info.hash).unwrap(), data, "len {len}");
        assert!(store.verify(&info.hash).unwrap());
    }
}

#[test]
fn stored_blob_is_read_only() {
    let (_dir, store) = store();
    let info = store.put_bytes(b"jangan diubah").unwrap();
    let meta = fs::metadata(store.path_of(&info.hash)).unwrap();
    assert!(meta.permissions().readonly());
}

#[test]
fn same_content_is_stored_once() {
    let (dir, store) = store();
    let a = store.put_bytes(b"isi sama").unwrap();
    let b = store.put_bytes(b"isi sama").unwrap();
    let src = dir.path().join("sumber.txt");
    fs::write(&src, b"isi sama").unwrap();
    let c = store.put_file(&src).unwrap();
    let mut reader: &[u8] = b"isi sama";
    let d = store.put_reader(&mut reader).unwrap();
    assert_eq!(a, b);
    assert_eq!(a, c);
    assert_eq!(a, d);
    assert_eq!(blob_files(store.root()).len(), 1);
    assert_eq!(tmp_entries(&store), 0);

    store.put_bytes(b"isi lain").unwrap();
    assert_eq!(blob_files(store.root()).len(), 2);
}

#[test]
fn put_file_streams_a_multi_megabyte_file() {
    let (dir, store) = store();
    let data = pattern(5 * 1024 * 1024 + 123);
    let src = dir.path().join("besar.bin");
    fs::write(&src, &data).unwrap();

    let info = store.put_file(&src).unwrap();
    assert_eq!(info.size, data.len() as u64);
    assert_eq!(info.hash, BlobHash::of_bytes(&data));
    assert_eq!(store.read_all(&info.hash).unwrap(), data);
    assert!(store.verify(&info.hash).unwrap());
    // The source is left alone.
    assert_eq!(fs::read(&src).unwrap(), data);
    assert!(!fs::metadata(&src).unwrap().permissions().readonly());
}

#[test]
fn put_file_missing_source_is_storage_error_with_path() {
    let (dir, store) = store();
    let src = dir.path().join("tidak-ada.docx");
    let err = store.put_file(&src).unwrap_err();
    assert_eq!(err.code(), "storage");
    let msg = err.to_string();
    assert!(msg.contains("tidak-ada.docx"), "{msg}");
    assert!(msg.contains("Detail:"), "{msg}");
    assert!(!msg.contains('\u{2014}'));
    assert_eq!(tmp_entries(&store), 0);
}

#[test]
fn failing_reader_leaves_no_temp_file() {
    struct Broken(usize);
    impl Read for Broken {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            if self.0 == 0 {
                return Err(std::io::Error::other("koneksi putus"));
            }
            self.0 -= 1;
            buf[0] = 7;
            Ok(1)
        }
    }
    let (_dir, store) = store();
    let err = store.put_reader(&mut Broken(3)).unwrap_err();
    assert_eq!(err.code(), "storage");
    assert!(err.to_string().contains("koneksi putus"));
    assert_eq!(tmp_entries(&store), 0);
    assert!(blob_files(store.root()).is_empty());
}

#[test]
fn copy_to_creates_parents_and_a_writable_file() {
    let (dir, store) = store();
    let info = store.put_bytes(b"salinan kerja").unwrap();
    let dest = dir.path().join("working").join("doc1").join("Laporan.docx");
    store.copy_to(&info.hash, &dest).unwrap();
    assert_eq!(fs::read(&dest).unwrap(), b"salinan kerja");
    assert!(!fs::metadata(&dest).unwrap().permissions().readonly());
    fs::write(&dest, b"diedit").unwrap();
    // The blob itself is untouched.
    assert!(store.verify(&info.hash).unwrap());
    // No temp file left next to the destination.
    assert_eq!(fs::read_dir(dest.parent().unwrap()).unwrap().count(), 1);
}

#[test]
fn copy_to_replaces_existing_read_only_destination() {
    let (dir, store) = store();
    let info = store.put_bytes(b"versi baru").unwrap();
    let dest = dir.path().join("view").join("Laporan.docx");
    fs::create_dir_all(dest.parent().unwrap()).unwrap();
    fs::write(&dest, b"versi lama yang lebih panjang").unwrap();
    set_readonly(&dest).unwrap();

    store.copy_to(&info.hash, &dest).unwrap();
    assert_eq!(fs::read(&dest).unwrap(), b"versi baru");
    assert!(!fs::metadata(&dest).unwrap().permissions().readonly());
    fs::write(&dest, b"bisa ditulis").unwrap();
    assert_eq!(fs::read_dir(dest.parent().unwrap()).unwrap().count(), 1);
}

#[test]
fn verify_detects_tampering() {
    let (_dir, store) = store();
    let info = store.put_bytes(b"isi asli").unwrap();
    assert!(store.verify(&info.hash).unwrap());

    let path = store.path_of(&info.hash);
    make_writable(&path);
    fs::write(&path, b"isi palsu").unwrap();
    assert!(!store.verify(&info.hash).unwrap());
}

#[test]
fn put_replaces_a_damaged_blob_of_wrong_length() {
    let (_dir, store) = store();
    let info = store.put_bytes(b"isi asli").unwrap();
    let path = store.path_of(&info.hash);
    make_writable(&path);
    fs::write(&path, b"rusak").unwrap();

    let again = store.put_bytes(b"isi asli").unwrap();
    assert_eq!(again, info);
    assert!(store.verify(&info.hash).unwrap());
    assert!(fs::metadata(&path).unwrap().permissions().readonly());
}

#[test]
fn remove_deletes_and_reports_missing() {
    let (_dir, store) = store();
    let info = store.put_bytes(b"hapus aku").unwrap();
    assert!(store.remove(&info.hash).unwrap());
    assert!(!store.contains(&info.hash));
    assert!(!store.path_of(&info.hash).exists());
    assert!(!store.remove(&info.hash).unwrap());
    // Can be stored again after removal.
    store.put_bytes(b"hapus aku").unwrap();
    assert!(store.contains(&info.hash));
}

#[test]
fn missing_blob_is_not_found() {
    let (dir, store) = store();
    let hash = BlobHash::of_bytes(b"tidak pernah disimpan");
    assert!(!store.contains(&hash));
    let errors = [
        store.size(&hash).unwrap_err(),
        store.open_read(&hash).unwrap_err(),
        store.read_all(&hash).unwrap_err(),
        store.copy_to(&hash, &dir.path().join("x.txt")).unwrap_err(),
        store.verify(&hash).unwrap_err(),
    ];
    for err in errors {
        assert_eq!(err.code(), "not_found");
        assert!(
            err.to_string()
                .starts_with("Isi file ini tidak ada di laptop ini")
        );
        assert!(!err.to_string().contains('\u{2014}'));
    }
    // copy_to with a missing blob does not create the destination.
    assert!(!dir.path().join("x.txt").exists());
}

#[test]
fn open_removes_leftover_temp_files() {
    let dir = tempfile::tempdir().unwrap();
    let store = BlobStore::open(dir.path().join("blobs")).unwrap();
    let tmp = store.root().join(TMP_DIR_NAME);
    let old = std::time::SystemTime::now() - std::time::Duration::from_secs(3600);
    let leftover = |name: &str, bytes: &[u8]| {
        let path = tmp.join(name);
        fs::write(&path, bytes).unwrap();
        fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(old)
            .unwrap();
        path
    };
    leftover("0123456789abcdef0123456789abcdef", b"setengah");
    let ro = leftover("fedcba9876543210fedcba9876543210", b"read-only sisa");
    set_readonly(&ro).unwrap();
    let kept = store.put_bytes(b"tetap ada").unwrap();

    let reopened = BlobStore::open(store.root()).unwrap();
    assert_eq!(tmp_entries(&reopened), 0);
    assert_eq!(reopened.read_all(&kept.hash).unwrap(), b"tetap ada");
}

#[test]
fn open_keeps_fresh_temp_files_of_another_process() {
    let dir = tempfile::tempdir().unwrap();
    let store = BlobStore::open(dir.path().join("blobs")).unwrap();
    let fresh = store
        .root()
        .join(TMP_DIR_NAME)
        .join("0123456789abcdef0123456789abcdef");
    fs::write(&fresh, b"sedang ditulis Mira lain").unwrap();

    BlobStore::open(store.root()).unwrap();
    assert!(fresh.exists(), "a temp file written moments ago may belong to another window");
}

#[test]
fn open_skips_temp_files_of_running_puts() {
    let dir = tempfile::tempdir().unwrap();
    let store = BlobStore::open(dir.path().join("blobs")).unwrap();
    let path = store.root().join(TMP_DIR_NAME).join(random_hex());
    let temp = TempFile::create(path.clone(), true).unwrap();

    BlobStore::open(store.root()).unwrap();
    assert!(path.exists(), "an active temp file must survive open");
    drop(temp);
    assert!(!path.exists());
    BlobStore::open(store.root()).unwrap();
}

#[test]
fn concurrent_puts_of_same_content_all_succeed() {
    let (_dir, store) = store();
    let data = Arc::new(pattern(512 * 1024 + 9));
    let expected = BlobHash::of_bytes(&data);
    let handles: Vec<_> = (0..8)
        .map(|_| {
            let store = store.clone();
            let data = Arc::clone(&data);
            std::thread::spawn(move || store.put_bytes(&data))
        })
        .collect();
    for handle in handles {
        let info = handle.join().unwrap().unwrap();
        assert_eq!(info.hash, expected);
        assert_eq!(info.size, data.len() as u64);
    }
    assert_eq!(blob_files(store.root()).len(), 1);
    assert_eq!(tmp_entries(&store), 0);
    assert!(store.verify(&expected).unwrap());
}

#[test]
fn in_data_dir_uses_blobs_folder() {
    let dir = tempfile::tempdir().unwrap();
    let store = BlobStore::in_data_dir(dir.path()).unwrap();
    assert_eq!(store.root(), dir.path().join(BlobStore::DIR_NAME));
    assert!(store.root().join(TMP_DIR_NAME).is_dir());
}
