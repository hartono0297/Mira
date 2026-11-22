# Rencana Tahap 5 bagian lokal: Tanda tangan PDF

Tanggal: 22 November 2026. Branch: `claude/tahap-5-ttd-lokal-5fbb29` (dari `8d2023a`).
Sumber: `design/rencana-pembangunan.html` (Tahap 5), `design/prd-mira.html` (F-SIGN-01 sampai 06, F-UI, bagian 8 dan 9), `design/brainstorming.html` (Edit dan tanda tangan file), `design/tema-c.html`.

## 1. Tujuan dan batas

Satu laptop bisa: membuat tanda tangan (gambar dengan mouse atau pena, atau impor gambar) yang disimpan terlindungi PIN; membuka PDF; membuat permintaan tanda tangan (daftar penanda tangan, berurutan atau bebas); menempatkan dan mengubah ukuran tanda tangan di halaman dengan mouse dan keyboard; memasukkan PIN; menyimpan PDF bertanda tangan beserta catatan nama dan waktu, dan halaman catatan di akhir dokumen; mengunci hasilnya (hash BLAKE3 yang ditandatangani kunci laptop); lalu mendeteksi kalau file berubah. Jejak audit lokal mencatat siapa, kapan, dan hash.

Bukan lingkup: mengirim permintaan dan file ke rekan (butuh jaringan, disambung setelah Tahap 1 digabung), chat, board (F-SIGN-06 kartu pindah ke Selesai), edit Word/Excel, komentar dan stabilo PDF (F-DOC-06, Tahap 4 memakai ulang penampil PDF dari sini).

## 2. Keputusan

| Keputusan | Alasan |
|---|---|
| PIN 6 sampai 12 angka. | Cukup pendek untuk diketik tiap tanda tangan, lebih kuat dari 4 angka. |
| Kunci gambar = BLAKE3 `derive_key("mira signature key v1", argon2id(PIN, salt) ‖ pepper)`. Argon2id m=64 MiB, t=3, p=1. Gambar PNG dienkripsi XChaCha20-Poly1305 (nonce acak 24 byte, AAD = `mira-signature-v1` + kunci publik pemilik). | PIN tidak pernah disimpan. Tag AEAD sekaligus menjadi pemeriksa PIN, jadi tidak perlu hash PIN terpisah yang bisa ditebak lepas. |
| `pepper` = BLAKE3 dari tanda tangan Ed25519 kunci laptop atas `mira-signature-pepper-v1` ‖ salt (Ed25519 deterministik). | Mencuri `mira.db` saja tidak cukup untuk menebak PIN di komputer lain: penyerang juga butuh kunci laptop di Windows Credential Manager. Tidak perlu entri keyring baru. |
| Batas percobaan: setelah 5 salah berturut-turut terkunci 1 menit, 10 salah 5 menit, 15 salah 15 menit, 20 salah ke atas 60 menit per 5 kesalahan. Benar sekali mereset hitungan. | Menahan tebakan di layar tanpa membuat pemilik terkunci lama karena salah ketik. |
| Mengganti tanda tangan = hapus lalu buat baru. Hapus dengan PIN lama: tanda tangan baru langsung bisa dipakai. Hapus tanpa PIN (lupa PIN): tanda tangan baru baru bisa dipakai 24 jam setelah penghapusan. Keduanya tercatat di jejak audit, dan catatan yang terjadi selama permintaan berjalan tampil di jejak audit permintaan itu. | Diubah setelah review keamanan: tanpa masa tunggu, orang lain di laptop yang tidak terkunci bisa menghapus tanda tangan, membuat baru dengan PIN buatannya, lalu menandatangani atas nama pemilik. |
| Setiap tindakan tanda tangan butuh PIN. Kotak tanda tangan ditempatkan dulu (rasio dari lebar dan tinggi gambar yang disimpan tanpa enkripsi), PIN diminta di akhir. | Sesuai alur PRD: tempatkan, masukkan PIN, selesai. |
| `sign_unlock` membalas token sekali pakai berumur 5 menit plus gambar. `sign_complete` wajib membawa token itu. Token hanya di memori. | Stempel dikerjakan pdf-lib di frontend, jadi inti Rust butuh bukti bahwa PIN baru saja dimasukkan. |
| Teks stempel dan halaman catatan memakai Helvetica bawaan pdf-lib; karakter di luar WinAnsi diganti `?`. | Tanpa menambah fontkit. Nama Indonesia umumnya huruf Latin. |
| PDF disimpan pdf-lib dengan `useObjectStreams: false` dan kata kunci `mira-doc:<id>` di metadata. | Inti Rust bisa mengenali file Mira dengan memindai byte, juga setelah file diubah aplikasi lain. |
| Halaman catatan (F-SIGN-05) ditambahkan oleh penanda tangan terakhir sebelum mengirim versi final. | Hash final mencakup halaman catatan, jadi halaman itu ikut terkunci. |
| Penyimpanan PDF lewat trait `DocumentStore`; implementasi sementara `FolderStore` di `<data_dir>/ttd-berkas/<2 hex>/<hash>.pdf`. | Blob store BLAKE3 Tahap 4 ada di branch lain; saat merge cukup ganti implementasi. |
| Ekspor ke `MIRA_EXPORT_DIR` kalau diisi, kalau tidak ke folder Unduhan Windows. Nama `<judul> (ditandatangani).pdf`, tidak menimpa file yang ada. Lokasi ekspor dicatat dan diperiksa ulang setiap daftar dimuat. | Tidak perlu plugin dialog. File di luar Mira juga dijaga: kalau berubah, muncul peringatan. |
| Batas ukuran PDF 50 MB saat impor, 100 MB untuk versi bertanda tangan, gambar tanda tangan 1 MB dan maksimal 2000 x 2000 piksel. | Wajar untuk kontrak; mencegah memori habis. pdf-lib menyimpan ulang tanpa object stream, jadi hasil stempel bisa sekitar dua kali lebih besar. |
| Byte PDF lewat IPC mentah Tauri 2 (`tauri::ipc::Request` dan `Response`), bukan JSON array. | PDF beberapa MB jadi ratusan ribu angka di JSON, lambat. |
| Satu varian error baru `AppError::Signing { code, message }`. | Hanya satu baris enum dan satu baris `code()`, sehingga merge dengan tahap lain mudah. |
| Layar "Tanda tangan" sendiri di sidebar (`src/screens/sign/`). | Layar Dokumen milik Tahap 4. Setelah merge, daftar "menunggu tanda tangan" bisa dipindah ke Dokumen. |
| Pustaka: `pdfjs-dist` 6.5.438, `pdf-lib` 1.17.1, `argon2` 0.6.0, `chacha20poly1305` 0.11.0, `proptest` 1.12.0 (dev), semua dipin tepat. | Versi stabil terbaru pada 22 November 2026. |

## 3. Skema (satu entri migrasi, `signing/schema.rs`)

Tabel `sign_saved_signature`, `sign_requests`, `sign_signers`, `sign_events`, `sign_exports`. Lihat `src-tauri/src/signing/schema.rs`. Didaftarkan di akhir `MIGRATIONS` (sekarang v3; nomor final saat merge karena Tahap 3 dan 4 juga menambah).

## 4. Inti Rust (`src-tauri/src/signing/`)

| File | Isi |
|---|---|
| `pin.rs` | `validate_pin`, `KdfParams`, `derive_key`, `seal_image`, `open_image`, `pepper_from_identity`, `validate_png`, kebijakan percobaan (`Attempts`, `check_locked`, `register_failure`). |
| `vault.rs` | Tanda tangan tersimpan di SQLite: `status`, `save`, `delete`, `unlock` (menghitung salah dan kunci waktu). |
| `request.rs` | Model murni: `SignMode`, `SignerKind`, `SignerStatus`, `Signer`, `SignRequest`, `NewRequest`, `Requester`, `validate_new`, `can_sign`, `record_signature`, `cancel`, `my_state`, `is_last_pending`. Tes unit dan proptest. |
| `seal.rs` | `hash_hex` (BLAKE3), `EventKind`, `EventRecord`, `record_bytes`, `sign_event`, `verify_event`, `find_mira_doc_id`, `looks_like_pdf`, `Integrity`. |
| `store.rs` | `trait DocumentStore { put, get, contains }`, `FolderStore`, `MemoryStore`, `MAX_PDF_BYTES`. |
| `session.rs` | `SignSessions`: token unlock di memori, 5 menit, sekali pakai. Dikelola Tauri (`app.manage`). |
| `outbox.rs` | Titik sambung jaringan: `trait SignOutbox { request_created, version_signed, request_cancelled }` dan `LocalOnlyOutbox` (tidak mengirim apa pun). |
| `repo.rs` | Baca tulis tabel `sign_*`. |
| `service.rs` | Alur: impor PDF, buat permintaan, unlock, selesai tanda tangan, batal, ekspor, periksa file, ringkasan. Fungsi biasa yang bisa dites tanpa Tauri. |
| `commands.rs` | Perintah Tauri (tipis). |

Format byte yang ditandatangani untuk satu catatan jejak audit:
```
mira-sign-event-v1\n<request_id atau kosong>\n<kind>\n<actor hex>\n<actor_name>\n<at>\n<hash_before atau kosong>\n<hash_after atau kosong>\n<detail>
```
Field tidak boleh berisi baris baru (ditolak). Ditandatangani kunci laptop (`Identity::sign`), diverifikasi dengan `identity::verify_hex` memakai `actor`.

Jenis catatan: `created`, `signed`, `completed`, `cancelled`, `exported`, `signature_saved`, `signature_deleted`.

## 5. Kontrak perintah

Argumen camelCase, hasil camelCase, error `{ code, message }`.

| Perintah | Masukan | Hasil |
|---|---|---|
| `sign_overview` | - | `SignOverview` |
| `sign_save_signature` | `{ pin, pngBase64 }` | `SavedSignatureInfo` |
| `sign_delete_signature` | `{ pin: string \| null }` | `null` |
| `sign_unlock` | `{ pin }` | `{ token, pngBase64, signedAt, width, height }` |
| `sign_list_candidates` | - | `Candidate[]` |
| `sign_import_pdf` | badan mentah = byte PDF, header `x-mira-file-name` (encodeURIComponent) | `{ fileHash, size, fileName, pageCount: null }` |
| `sign_create_request` | `{ title, fileHash, mode, signers: string[] }` (kunci publik berurutan) | `RequestDetail` |
| `sign_get_request` | `{ id }` | `RequestDetail` |
| `sign_read_file` | `{ id, hash }` (hash harus milik permintaan itu) | byte mentah (ArrayBuffer) |
| `sign_complete` | badan mentah = PDF bertanda tangan, header `x-mira-request`, `x-mira-token`, `x-mira-base-hash` | `RequestDetail` |
| `sign_cancel` | `{ id }` | `RequestDetail` |
| `sign_export` | `{ id }` | `{ path }` |
| `sign_verify_file` | badan mentah = byte PDF | `VerifyResult` |

Tipe:
```ts
type SavedSignatureInfo = { width: number; height: number; createdAt: string; failedAttempts: number; lockedUntil: string | null; attemptsLeft: number; usableAfter: string | null };
type MyState = "your_turn" | "waiting_others" | "signed" | "not_involved";
type Integrity = "intact" | "changed" | "missing";
type RequestSummary = { id: string; title: string; mode: "sequential" | "parallel"; status: "in_progress" | "completed" | "cancelled"; myState: MyState; signedCount: number; signerCount: number; createdAt: string; updatedAt: string; completedAt: string | null; integrity: Integrity; exportWarnings: number };
type SignOverview = { saved: SavedSignatureInfo | null; requests: RequestSummary[]; canRequest: boolean; me: { publicKey: string; displayName: string; kind: "member" | "guest" } };
type Candidate = { publicKey: string; displayName: string; kind: "member" | "guest"; isMe: boolean };
type SignerView = { position: number; publicKey: string; displayName: string; kind: "member" | "guest"; status: "waiting" | "signed"; signedAt: string | null; hashAfter: string | null; isMe: boolean; canSignNow: boolean };
type EventView = { kind: string; actorKey: string; actorName: string; at: string; hashBefore: string | null; hashAfter: string | null; detail: string; valid: boolean };
type ExportView = { path: string; exportedAt: string; state: Integrity };
type RequestDetail = RequestSummary & { requestedBy: { publicKey: string; displayName: string }; originalHash: string; currentHash: string; signers: SignerView[]; events: EventView[]; exports: ExportView[]; isLastPending: boolean; docTag: string; sealValid: boolean | null };
type VerifyResult = { state: "match_final" | "match_version" | "changed" | "unknown"; fileHash: string; requestId: string | null; title: string | null; completedAt: string | null; signers: { displayName: string; signedAt: string | null }[] };
```

Kode error tanda tangan: `pin_invalid`, `pin_wrong`, `pin_locked`, `signature_cooling`, `pin_mismatch` (frontend saja), `signature_missing`, `signature_exists`, `image_invalid`, `pdf_invalid`, `pdf_too_large`, `request_invalid`, `guest_cannot_request`, `not_a_signer`, `not_your_turn`, `already_signed`, `request_closed`, `not_requester`, `session_expired`, `version_conflict`, `tag_missing`, `export_failed`. Error lama dipakai ulang: `not_found`, `removed`, `database`, `internal`.

## 6. Frontend

| Lokasi | Isi |
|---|---|
| `src/components/pdf/` | Penampil PDF yang bisa dipakai ulang Tahap 4: `pdfjs.ts` (worker dan data font dibundel, tanpa eval), `PdfViewer.tsx` (halaman, zoom, navigasi, slot lapisan per halaman), `coords.ts` (layar ke koordinat PDF, dengan rotasi), `PlacementBox.tsx` (kotak yang dipindah dan diubah ukurannya dengan mouse dan keyboard). |
| `src/screens/sign/pad/` | `SignaturePad.tsx` (gambar dengan mouse atau pena, tekanan pena), `image.ts` (impor gambar, buang latar putih, pangkas, PNG), `SignatureSetupDialog.tsx`, `PinDialog.tsx`. |
| `src/screens/sign/stamp.ts` | `stampSignature`, `appendAuditPage`, `formatSignedAt` (pdf-lib). |
| `src/api/signing.ts` | Panggilan perintah di atas, termasuk IPC mentah. |
| `src/screens/sign/` | `SignScreen.tsx` (daftar, tanda tangan saya, periksa file), `NewRequestDialog.tsx`, `VerifyDialog.tsx`, `SignDocumentView.tsx` (penampil + panel urutan + penempatan + PIN + simpan), `AuditTrail.tsx`. |
| `src/screens/shell/Shell.tsx` | Satu menu "Tanda tangan" (perubahan minimal). |

Aksesibilitas: setiap fungsi bisa dengan keyboard (gambar tanda tangan punya alternatif impor gambar; kotak tanda tangan: panah memindah 5 pt, Shift+panah 20 pt, Alt+panah mengubah ukuran, juga tombol posisi cepat), fokus terlihat, error dibacakan `aria-live`, kontras AA dicek `check_contrast`, tanpa em dash.

## 7. Tugas dan pembagian subagent

Fase 1 (paralel, file terpisah):
1. Rust `pin.rs` + `vault.rs` + tes (worktree terpisah).
2. Rust `request.rs` + tes + proptest (worktree terpisah).
3. Rust `seal.rs` + `store.rs` + tes (worktree terpisah).
4. Frontend `src/components/pdf/` + tes `coords` dan `PlacementBox`, CSP worker.
5. Frontend `stamp.ts` + tes Vitest dengan PDF buatan pdf-lib.
6. Frontend `src/screens/sign/pad/` + tes.

Fase 2 (paralel):
7. Rust `session.rs`, `outbox.rs`, `repo.rs`, `service.rs`, `commands.rs`, daftar di `lib.rs` + tes alur.
8. Frontend layar daftar, permintaan baru, periksa file, menu sidebar.
9. Frontend layar dokumen (penampil, penempatan, PIN, simpan, jejak audit).

Fase 3: review keamanan Rust, review tampilan dan aksesibilitas, review kode umum; perbaikan.

Fase 4: uji ujung ke ujung `scripts/sign-e2e.mjs` terhadap build debug tanpa bundel (`tauri build --debug --no-bundle`), `MIRA_DATA_DIR` dan `MIRA_EXPORT_DIR` di folder scratch, PDF uji buatan sendiri, screenshot terang dan gelap ke `docs/progress/screenshots/`. Laporan `docs/progress/tahap-5-lokal.md`.

## 8. Verifikasi selesai

- `cargo test`, `cargo clippy --all-targets`, `cargo fmt --check` bersih.
- `npm test` (Vitest) dan `tsc` lulus.
- Uji ujung ke ujung: buat tanda tangan, buka PDF, tempatkan dengan keyboard, PIN salah lalu benar, simpan, ekspor, periksa file (asli), ubah satu byte file ekspor, peringatan muncul di daftar dan di Periksa file.
