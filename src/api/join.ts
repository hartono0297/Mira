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
};

// Batas keterangan untuk admin, dalam karakter (sama dengan Rust).
export const JOIN_NOTE_MAX_CHARS = 80;

export type JoinSearch = {
  offices: FoundOffice[];
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
  sendRequest: (officeKey: string, teamId: string, confirmFingerprint: string | null = null, note: string | null = null) =>
    call<OutgoingJoinRequest>("join_send_request", { officeKey, teamId, confirmFingerprint, note }),
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
