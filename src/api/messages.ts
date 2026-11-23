import type { AppError, NetState } from "./types";

// Teks status koneksi (docs/plans/tahap-1.md 2.6).
export const NET_STATE_TEXT: Record<NetState, string> = {
  starting: "Mencari laptop rekan...",
  no_org: "Belum tergabung di organisasi",
  alone: "Belum ada rekan di organisasi",
  lan: "Tersambung lewat LAN kantor",
  vpn: "Tersambung lewat VPN",
  offline: "Tidak tersambung ke jaringan kantor",
  removed: "Laptop ini sudah dikeluarkan dari organisasi",
};

export const OFFLINE_HINT = "Kalau sedang di luar kantor, nyalakan VPN kantor.";

export type ErrorText = { title: string; body: string; steps?: string[] };

// Penjelasan untuk error saat memakai kode undangan, dipakai saat bergabung
// (onboarding) dan saat anggota memakai kode untuk tim lain.
export function inviteErrorText(error: AppError): ErrorText {
  switch (error.code) {
    case "invite_invalid":
      return { title: "Kode undangan tidak valid", body: error.message };
    case "invite_not_found":
      return {
        title: "Kode tidak dikenali",
        body: "Laptop rekan yang ditemukan tidak mengenal kode ini. Periksa lagi kodenya huruf demi huruf, atau minta kode baru ke admin departemen.",
      };
    case "invite_expired":
      return {
        title: "Kode sudah kedaluwarsa",
        body: "Masa berlaku kode ini sudah habis. Minta kode baru ke admin departemen yang mengundang Anda.",
      };
    case "invite_used":
      return {
        title: "Kode sudah dipakai",
        body: "Kode sekali pakai ini sudah dipakai untuk bergabung. Minta kode baru ke admin departemen.",
      };
    case "invite_revoked":
      return {
        title: "Kode sudah dicabut",
        body: "Admin sudah membatalkan kode ini. Minta kode baru ke admin departemen.",
      };
    case "no_peer_found":
      return {
        title: "Belum ada laptop rekan yang ditemukan",
        body: "Kode hanya bisa diperiksa oleh laptop anggota organisasi yang sedang membuka Mira. Coba langkah berikut, lalu tekan Gabung lagi:",
        steps: [
          "Sambungkan laptop ini ke Wi-Fi atau kabel LAN kantor yang sama dengan rekan. Wi-Fi tamu biasanya memisahkan laptop satu sama lain.",
          "Kalau sedang di luar kantor, nyalakan VPN kantor.",
          "Pastikan firewall di laptop ini dan di laptop rekan mengizinkan Mira (Windows Firewall di Windows, Firewall macOS di MacBook).",
          "Minta rekan membuka Pengaturan > Jaringan di Mira, lalu isi alamat laptopnya di kolom Alamat laptop rekan.",
        ],
      };
    // Rust memakai kode ini saat laptop rekan menolak dengan alasan yang tidak
    // dikenal; pesannya membawa keterangan dari laptop rekan.
    case "peer_unreachable":
      return {
        title: "Laptop rekan tidak bisa memeriksa kode",
        body: `${error.message} Coba lagi sebentar lagi. Kalau tetap gagal, minta kode baru ke admin departemen.`,
      };
    case "name_required":
      return {
        title: "Nama tampilan belum tersimpan",
        body: "Laptop ini belum punya nama tampilan. Muat ulang data laptop ini, lalu isi nama sebelum bergabung.",
      };
    case "already_in_org":
      return {
        title: "Laptop ini sudah tergabung di organisasi",
        body: "Muat ulang data laptop ini untuk membuka organisasinya.",
      };
    case "removed":
      return {
        title: "Laptop ini sudah dikeluarkan dari organisasi",
        body: "Laptop yang sudah dikeluarkan tidak bisa bergabung lagi, juga dengan kode undangan baru. Kalau ini keliru, hubungi superadmin organisasi.",
      };
    case "forbidden":
      return { title: "Anda tidak punya izin untuk ini", body: error.message };
    case "network":
      return { title: "Jaringan bermasalah", body: error.message };
    default:
      return { title: "Kode belum bisa dipakai", body: error.message };
  }
}

// Judul error untuk aksi di halaman Organisasi.
export function actionErrorTitle(error: AppError, fallback: string): string {
  switch (error.code) {
    case "forbidden":
      return "Anda tidak punya izin untuk ini";
    case "last_superadmin":
      return "Organisasi butuh minimal satu superadmin";
    case "not_found":
      return "Data sudah berubah";
    default:
      return fallback;
  }
}
