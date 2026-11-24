import { API_TEXT } from "../i18n/api";
import { subscribeLang } from "../i18n/core";
import type { AppError, NetState } from "./types";

// Teks status koneksi (docs/plans/tahap-1.md 2.6), mengikuti bahasa aktif.
export const NET_STATE_TEXT: Record<NetState, string> = API_TEXT.netState;

// String biasa tidak bisa membaca bahasa saat dipakai, jadi nilainya diganti
// setiap bahasa berganti. Impor ES memakai ikatan hidup, jadi pemakai ikut.
export let OFFLINE_HINT: string = API_TEXT.offlineHint;
subscribeLang(() => {
  OFFLINE_HINT = API_TEXT.offlineHint;
});

export type ErrorText = { title: string; body: string; steps?: string[] };

// Penjelasan untuk error saat memakai kode undangan, dipakai saat bergabung
// (onboarding) dan saat anggota memakai kode untuk tim lain.
export function inviteErrorText(error: AppError): ErrorText {
  const t = API_TEXT.inviteError;
  switch (error.code) {
    case "invite_invalid":
      return { title: t.invalidTitle, body: error.message };
    case "invite_not_found":
      return { title: t.notFoundTitle, body: t.notFoundBody };
    case "invite_expired":
      return { title: t.expiredTitle, body: t.expiredBody };
    case "invite_used":
      return { title: t.usedTitle, body: t.usedBody };
    case "invite_revoked":
      return { title: t.revokedTitle, body: t.revokedBody };
    case "no_peer_found":
      return { title: t.noPeerTitle, body: t.noPeerBody, steps: [...t.noPeerSteps] };
    // Rust memakai kode ini saat laptop rekan menolak dengan alasan yang tidak
    // dikenal; pesannya membawa keterangan dari laptop rekan.
    case "peer_unreachable":
      return { title: t.peerUnreachableTitle, body: t.peerUnreachableBody(error.message) };
    case "name_required":
      return { title: t.nameRequiredTitle, body: t.nameRequiredBody };
    case "already_in_org":
      return { title: t.alreadyInOrgTitle, body: t.alreadyInOrgBody };
    case "removed":
      return { title: t.removedTitle, body: t.removedBody };
    case "forbidden":
      return { title: API_TEXT.forbiddenTitle, body: error.message };
    case "network":
      return { title: t.networkTitle, body: error.message };
    default:
      return { title: t.defaultTitle, body: error.message };
  }
}

// Judul error untuk aksi di halaman Organisasi.
export function actionErrorTitle(error: AppError, fallback: string): string {
  switch (error.code) {
    case "forbidden":
      return API_TEXT.forbiddenTitle;
    case "last_superadmin":
      return API_TEXT.lastSuperadminTitle;
    case "not_found":
      return API_TEXT.notFoundTitle;
    default:
      return fallback;
  }
}
