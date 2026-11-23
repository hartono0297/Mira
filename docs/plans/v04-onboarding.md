# Rencana Onboarding v0.4

Permintaan user: "untuk menu awal setelah user download, gw maunya dia cuma isi nama dan pilih depart lalu pilih mau join domain mana. jadi nanti superadmin bisa cek user ini legit atau engga."

Dasar: `docs/plans/v0.3-kontrak.md` bagian 8, `docs/progress/v03-a.md`, `docs/progress/v03-b.md`.

## Alur orang baru

1. **Nama** (Langkah 1 dari 3). Satu isian nama tampilan, tombol "Lanjut".
2. **Firewall** hanya tampil kalau aturan Mira belum ada. Kalau sudah diizinkan atau tidak didukung, langsung lewat. Tombol "Lewati, atur nanti" tetap ada.
3. **Mencari kantor** (Langkah 2 dari 3, paling lama 15 detik).
4. **Pilih kantor, departemen, keterangan** (masih Langkah 2 dari 3), dalam satu formulir dengan urutan: kantor (satu kantor: terpilih otomatis dan tampil dengan nama dan sidik; beberapa: daftar pilihan), departemen (aktif setelah kantor dipilih, daftarnya dari kantor itu), "Keterangan untuk admin (opsional)" paling banyak 80 karakter, lalu "Kirim permintaan". Nama ditampilkan sebagai ringkasan dengan tombol "Ubah".
5. **Menunggu persetujuan** (Langkah 3 dari 3), ditolak, kirim ulang, batal: tetap seperti v0.3.

Cadangan tetap: alamat laptop rekan, kode undangan.

## Kantor baru disembunyikan

- Layar "Kantor belum ditemukan" hanya berisi: Cari lagi, alamat laptop rekan, kode undangan, dan bagian lipat "Untuk admin IT".
- Di dalam bagian itu: penjelasan singkat dan tombol "Siapkan Mira untuk kantor baru". Kalau di sesi ini pernah terlihat kantor atau pengumuman organisasi, tombolnya diganti penjelasan (kantor sudah ada di jaringan, minta bergabung saja).
- Layar kantor baru: peringatan VPN, nama organisasi, nama Anda, departemen Anda, lalu "Ketik ulang nama organisasi" yang harus sama persis. Tombol "Buat organisasi" tetap aktif; kalau ketikan ulangnya berbeda, isian itu menampilkan pesan dan organisasi tidak dibuat (tombol yang dinonaktifkan tidak menjelaskan alasannya ke pembaca layar).
- Argumen peluncuran `--siapkan-kantor` (command `join_setup_mode`) membuka layar kantor baru langsung setelah langkah nama dilewati.

## Data verifikasi

`JoinRequestPayload` mendapat dua field opsional, ditulis hanya kalau ada (`skip_serializing_if`), sehingga permintaan tanpa keduanya sama persis dengan bentuk v0.3:

| Field | Isi | Batas |
|---|---|---|
| `note` | keterangan untuk admin dari peminta | 1 sampai 80 karakter, tanpa karakter kontrol atau bidi, tanpa spasi di awal/akhir |
| `account` | nama akun login Windows (`USERNAME`) atau macOS (`USER`) | 1 sampai 64 karakter, aturan sama |

`MAX_JOIN_REQUEST_BYTES` tetap 2048 (cukup: nama 50, laptop 64, akun 64, keterangan 80 karakter).

Kompatibilitas: laptop v0.3 memakai `deny_unknown_fields`, jadi menolak payload yang membawa field baru. Karena itu:

- Jawaban `join_info` dari laptop v0.4 membawa field tambahan `extras: 1` (`JoinInfoWire`, tanpa `deny_unknown_fields` di v0.3, jadi aman).
- Peminta hanya menulis `note` dan `account` kalau semua laptop anggota yang menjawab untuk kantor itu membawa `extras >= 1` (`FoundOffice.acceptsNote`). Kalau tidak, permintaan berbentuk v0.3 dan layar tidak menampilkan isian keterangan.
- Sisa risiko: laptop v0.3 lain di kantor yang sama (bukan yang menjawab) menolak op `join_approve` dengan field baru saat fold, sampai diperbarui ke v0.4. Fold dihitung ulang dari semua op, jadi setelah diperbarui orang itu langsung terhitung anggota.

`JoinRequestView` mendapat `note` dan `account` (null untuk permintaan v0.3). `OutgoingJoinRequest` mendapat `note`. `JoinDevice` mendapat `account`. `join_resend` memakai keterangan permintaan sebelumnya.

## Kartu Permintaan bergabung

Menampilkan nama, departemen, keterangan, nama laptop, akun login, IP, sistem, versi Mira, waktu, dan kode cocok besar, plus petunjuk: "Pastikan orangnya benar: telepon atau datangi orangnya dan minta ia membacakan kode di layarnya. Setujui hanya kalau kodenya sama."

## Satu aplikasi untuk semua peran

Tab Organisasi: Pengguna dan Label hanya superadmin (sudah), Permintaan bergabung untuk superadmin dan admin departemen (sudah), Departemen hanya superadmin (baru; anggota biasa melihat departemen orang di tab Anggota). Undangan hanya untuk yang bisa membuat undangan atau memakai kode.

## Pembagian kerja

| Bagian | File |
|---|---|
| Rust | `permissions/join.rs`, `permissions/join_store.rs`, `join_commands.rs`, `network/mod.rs` (`JoinInfoWire`), `net_backend.rs` (isi `extras`), `lib.rs` (registrasi `join_setup_mode`) |
| Layar onboarding | `src/screens/onboarding/**` |
| Kartu admin dan tab | `src/screens/org/JoinRequestsPanel.*`, `src/screens/org/OrgScreen.*`, `src/test/orgFixtures.ts` |
| Uji ujung ke ujung | `scripts/join-e2e.mjs`, `scripts/e2e-onboarding.mjs`, `scripts/org-e2e.mjs` |
