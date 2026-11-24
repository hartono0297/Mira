// Kalimat umum per kode error. Saat bahasa Indonesia aktif, pesan dari inti
// Rust tampil apa adanya, jadi `byCode` di sini hanya padanan dan dokumentasi
// untuk errors.en.ts. Saat bahasa Inggris aktif, kalimat Inggris di kunci yang
// sama dipakai untuk pesan Rust yang tidak ada di errors-rust.*.ts.
const id = {
  byCode: {
    // Kode umum (src-tauri/src/error.rs)
    invalid_name: "Nama ini tidak bisa dipakai. Periksa lagi isinya.",
    name_required: "Isi nama tampilan dulu.",
    org_exists: "Laptop ini sudah memegang sebuah organisasi.",
    keystore: "Kunci laptop ini tidak bisa dibaca atau disimpan.",
    key_mismatch: "Kunci laptop ini tidak cocok dengan identitas yang tersimpan.",
    database: "Database lokal Mira tidak bisa dibaca atau ditulis.",
    internal: "Terjadi kesalahan di inti Mira. Coba lagi, atau tutup lalu buka lagi Mira.",
    invalid_setting: "Pengaturan ini tidak valid.",
    forbidden: "Anda tidak punya izin untuk ini.",
    not_found: "Data yang dicari tidak ditemukan. Mungkin sudah dihapus atau berubah.",
    invite_invalid: "Kode undangan tidak valid.",
    invite_not_found: "Kode undangan tidak dikenal oleh laptop rekan yang ditemukan.",
    invite_expired: "Kode undangan ini sudah kedaluwarsa. Minta kode baru ke admin departemen.",
    invite_used: "Kode undangan sekali pakai ini sudah dipakai. Minta kode baru ke admin departemen.",
    invite_revoked: "Kode undangan ini sudah dicabut. Minta kode baru ke admin departemen.",
    no_peer_found: "Tidak ada laptop rekan yang ditemukan di jaringan.",
    peer_unreachable: "Laptop rekan tidak bisa menanggapi permintaan ini.",
    already_in_org: "Laptop ini sudah tergabung dalam sebuah organisasi.",
    removed: "Laptop ini sudah dikeluarkan dari organisasi.",
    suspended: "Akun Anda di organisasi ini sedang dinonaktifkan. Hubungi IT atau superadmin kantor.",
    last_superadmin: "Organisasi harus punya minimal satu superadmin.",
    invalid_address: "Alamat laptop rekan tidak valid.",
    network: "Jaringan bermasalah. Periksa sambungan ke jaringan kantor, lalu coba lagi.",
    // Dokumen (tahap 4)
    storage: "File di laptop ini tidak bisa dibaca atau ditulis. Periksa ruang disk dan izin akses.",
    invalid_input: "Isian ini tidak bisa dipakai. Periksa lagi, lalu coba lagi.",
    document_editing: "Dokumen ini sedang diedit. Simpan dan tutup filenya di Office dulu.",
    open_failed: "File tidak bisa dibuka di laptop ini.",
    not_available: "File ini belum bisa diunduh karena tidak ada laptop rekan tersambung yang menyimpannya.",
    // Tanda tangan (AppError::Signing, tahap 5)
    pin_invalid: "PIN harus 6 sampai 12 angka.",
    pin_wrong: "PIN salah.",
    pin_locked: "Terlalu banyak PIN salah. Tanda tangan dikunci sementara.",
    pin_mismatch: "Kedua PIN tidak sama.",
    signature_missing: "Belum ada tanda tangan tersimpan. Buat tanda tangan dulu.",
    signature_exists: "Tanda tangan sudah tersimpan. Hapus dulu kalau ingin menggantinya.",
    signature_cooling:
      "Tanda tangan ini belum bisa dipakai karena tanda tangan lama dihapus tanpa PIN. Tunggu sampai masa tunggu 24 jam selesai.",
    image_invalid: "Gambar tanda tangan tidak bisa dipakai. Gambar ulang atau pilih gambar PNG lain.",
    pdf_invalid: "File PDF ini tidak bisa diproses Mira.",
    pdf_too_large: "File PDF terlalu besar.",
    request_invalid: "Permintaan tanda tangan ini tidak valid.",
    guest_cannot_request: "Tamu tidak bisa meminta tanda tangan.",
    not_a_signer: "Anda tidak ada di daftar penanda tangan permintaan ini.",
    not_your_turn: "Belum giliran Anda menandatangani.",
    already_signed: "Anda sudah menandatangani dokumen ini.",
    request_closed: "Permintaan ini sudah selesai atau dibatalkan.",
    not_requester: "Hanya pengirim permintaan yang bisa melakukan ini.",
    session_expired: "Waktu konfirmasi PIN sudah habis. Masukkan PIN lagi.",
    version_conflict: "Dokumen ini sudah berubah sejak Anda membukanya. Muat ulang dokumen, lalu coba lagi.",
    tag_missing: "File ini tidak memuat penanda dokumen Mira untuk permintaan ini.",
    export_failed: "Salinan file tidak bisa disimpan.",
    version_not_prefix: "Versi baru tidak dibangun di atas versi sebelumnya.",
    version_changes_content: "Versi baru mengubah isi dokumen, bukan hanya menambah tanda tangan.",
    // Pembaruan (src-tauri/src/updater.rs)
    update_offline: "Tidak bisa menghubungi GitHub. Coba lagi saat laptop tersambung ke internet.",
    update_not_configured: "Pembaruan otomatis belum disiapkan di versi Mira ini.",
    update_no_pending: "Belum ada pembaruan yang diunduh. Cek pembaruan dulu.",
    update_bad_signature: "Berkas pembaruan tidak cocok dengan tanda tangan Mira, jadi tidak dipasang.",
    update_failed: "Pembaruan gagal.",
    // Kode buatan tampilan (src/api/index.ts)
    no_tauri: "Halaman ini dibuka di browser biasa, jadi tidak bisa membaca data Mira di laptop ini.",
    unknown: "Terjadi kesalahan yang tidak dikenali.",
  },
  // Kode yang tidak dikenal sama sekali.
  generic: "Terjadi kesalahan. Coba lagi.",
  // toAppError: error yang bukan AppError.
  unknownDetail: (detail: string) => `Terjadi kesalahan yang tidak dikenali: ${detail}`,
};

export default id;
