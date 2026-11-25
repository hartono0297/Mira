// Bergabung ke kantor lewat permintaan (v0.3, docs/plans/v0.3-kontrak.md bagian 8).
// Sisi Rust: src-tauri/src/join_commands.rs. Laptop tanpa organisasi mencari
// kantor lewat mDNS, mengirim permintaan bertanda tangan, lalu menunggu
// superadmin atau admin departemen menyetujuinya.
import { invoke } from "@tauri-apps/api/core";
import { isTauri, NO_TAURI_ERROR, toAppError } from ".";
import { localizeError } from "../i18n/errors";
import type { OrgInfo } from "./types";

// Data laptop ini yang nanti dilihat penyetuju (layar "Mencari kantor").
export type JoinDevice = {
  laptop: string;
  os: string;
  appVersion: string;
  // Nama akun login Windows atau macOS (v0.4), dibaca dari sistem dan ikut
  // permintaan bertanda tangan supaya admin bisa memastikan siapa pemintanya.
  // null kalau tidak terbaca.
  account: string | null;
  // Alamat IPv4 laptop ini tanpa port, misalnya "192.168.1.23".
  addresses: string[];
};

export type JoinDepartment = { id: string; name: string };

// Satu kantor yang ditemukan. Nama dan departemen berasal dari jawaban laptop
// anggota lewat QUIC (bukan dari pengumuman mDNS).
export type FoundOffice = {
  // Kunci untuk sendRequest: id organisasi dan sidik lengkapnya.
  key: string;
  orgId: string;
  name: string;
  // Sidik organisasi pendek, "XXXX-XXXX".
  fingerprint: string;
  departments: JoinDepartment[];
  // Laptop anggota yang menjawab untuk kantor ini.
  peerCount: number;
  // Ada kantor lain dengan id sama tapi sidik berbeda: salah satunya tiruan.
  conflict: boolean;
  // Ada kantor lain dengan nama sama: bandingkan sidiknya.
  sameName: boolean;
  // Semua laptop anggota yang menjawab sudah v0.4: keterangan dan nama akun
  // ikut permintaan. false: permintaan berbentuk v0.3 (tanpa keduanya).
  acceptsNote: boolean;
  // Domain Active Directory yang diatur superadmin kantor ini, huruf kecil.
  adDomain: string | null;
  // Semua laptop anggota yang menjawab menerima data AD di permintaan.
  acceptsAd: boolean;
  // 0.5.1: jumlah laptop anggota yang belum diperbarui sehingga data AD tidak
  // bisa dipakai (paling besar dari laptop yang menjawab). null kalau laptop
  // yang menjawab memakai Mira lama yang tidak melaporkannya.
  adOutdated: number | null;
  // Waktu dibuat dari catatan genesis bertanda tangan (RFC 3339). Untuk
  // memilih "kantor utama" kalau ada beberapa kantor dengan domain AD sama.
  createdAt: string;
};

// Akun domain yang login di laptop ini (onboarding-ad). Selain domain,
// bagian lain bisa kosong kalau server domain tidak terjangkau.
export type LocalAd = {
  domain: string;
  // sAMAccountName, misalnya "hartono".
  user: string | null;
  dn: string | null;
  displayName: string | null;
  // Atribut department.
  department: string | null;
  // false: hanya terbaca sebagian.
  complete: boolean;
};

// Asal usulan departemen.
export type AdDeptSource = "attribute" | "attribute_map" | "ou_map" | "ou_name";

export type AdDeptSuggestion = {
  teamId: string | null;
  source: AdDeptSource | null;
  // Departemen menurut AD: atribut department, atau OU paling dalam.
  adDepartment: string | null;
  // teamId ditemukan di kantor Mira.
  inMira: boolean;
};

// Data AD yang ikut permintaan bertanda tangan.
export type JoinAdClaim = {
  domain: string;
  user: string;
  dn: string | null;
  name: string | null;
  department: string | null;
};

// Batas keterangan untuk admin, dalam karakter (sama dengan Rust).
export const JOIN_NOTE_MAX_CHARS = 80;

// Kantor yang laptopnya memakai Mira lama (0.1/0.2): mengumumkan organisasi
// lewat mDNS tapi belum bisa menerima permintaan bergabung. Tidak terverifikasi.
export type LegacyOffice = {
  orgId: string;
  // Nama dari pengumuman mDNS kalau ada (sudah dibersihkan), null kalau tidak ada.
  name: string | null;
  // Jumlah laptop yang mengumumkan organisasi ini.
  peerCount: number;
};

export type JoinSearch = {
  offices: FoundOffice[];
  // Kantor Mira versi lama di jaringan ini (lihat LegacyOffice).
  legacyOffices: LegacyOffice[];
  // Ada laptop yang mengumumkan organisasi di jaringan ini, walau belum ada
  // yang menjawab. Pilihan "kantor baru" disembunyikan kalau true.
  orgSeen: boolean;
  mdnsOk: boolean;
  mdnsError: string | null;
};

export type OutgoingJoinRequest = {
  requestId: string;
  // "XXXX XXXX", sama dengan di kartu penyetuju.
  code: string;
  // "XXXX-XXXX".
  orgFingerprint: string;
  orgId: string;
  orgName: string;
  teamId: string;
  teamName: string;
  displayName: string;
  // Keterangan untuk admin (v0.4), null kalau dikosongkan atau kantor belum mendukungnya.
  note: string | null;
  // Data AD yang ikut permintaan (onboarding-ad), null kalau tidak ada.
  ad: JoinAdClaim | null;
  createdAt: string;
  status: "pending" | "rejected";
  decidedByName: string | null;
  decidedAt: string | null;
  lastSentAt: string | null;
  lastError: string | null;
};

export type JoinPoll =
  | { status: "none" }
  | { status: "pending"; request: OutgoingJoinRequest }
  | { status: "rejected"; request: OutgoingJoinRequest }
  | { status: "approved"; org: OrgInfo };

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) throw NO_TAURI_ERROR;
  try {
    return await invoke<T>(command, args);
  } catch (err) {
    throw localizeError(toAppError(err));
  }
}

export const joinApi = {
  device: () => call<JoinDevice>("join_device"),
  // Satu putaran pencarian: kandidat mDNS saat ini, ditanyai lewat QUIC.
  // Dipanggil berulang selama 15 detik pencarian.
  search: () => call<JoinSearch>("join_search"),
  // Alamat laptop rekan yang diketik (VPN, Wi-Fi terpisah).
  connectAddress: (address: string) => call<FoundOffice[]>("join_connect_address", { address }),
  // Menyimpan nama tampilan dulu lewat api.saveDisplayName.
  // confirmFingerprint: sidik pendek yang sudah dicocokkan dengan superadmin.
  // Wajib untuk kantor yang conflict, selain itu null.
  // note: keterangan untuk admin (v0.4), null atau string kosong kalau tidak diisi.
  // useAd: sertakan data AD laptop ini kalau kantor menerimanya dan domainnya sama.
  sendRequest: (
    officeKey: string,
    teamId: string,
    confirmFingerprint: string | null = null,
    note: string | null = null,
    useAd = false,
  ) => call<OutgoingJoinRequest>("join_send_request", { officeKey, teamId, confirmFingerprint, note, useAd }),
  // Akun domain laptop ini, dibaca sekali (paling lama sekitar 4 detik).
  // null: bukan akun domain, macOS, atau tidak terbaca.
  adProfile: () => call<LocalAd | null>("join_ad_profile"),
  // Departemen usulan dari data AD untuk kantor itu. null kalau tidak ada data
  // AD atau domain laptop beda dengan domain kantor.
  adSuggest: (officeKey: string) => call<AdDeptSuggestion | null>("join_ad_suggest", { officeKey }),
  outgoing: () => call<OutgoingJoinRequest | null>("join_outgoing"),
  // Dipanggil tiap 5 detik selama layar menunggu terbuka.
  poll: () => call<JoinPoll>("join_poll"),
  cancel: () => call<null>("join_cancel"),
  // Setelah ditolak: permintaan baru (id dan kode baru) ke kantor dan departemen
  // yang sama, dengan keterangan yang sama.
  resend: () => call<OutgoingJoinRequest>("join_resend"),
  // Mira dibuka dengan argumen --siapkan-kantor (khusus admin IT, v0.4).
  setupMode: () => call<boolean>("join_setup_mode"),
};
