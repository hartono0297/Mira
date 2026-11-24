// Teks alur onboarding. Isinya di kamus src/i18n/onboarding.id.ts (sumber
// kebenaran) dan onboarding.en.ts; objek di sini selalu membaca bahasa aktif.
// Nama ekspor lama (STEP, NAME_STEP, OFFICE_STEP, ...) tetap, isinya bagian
// dari ONB.
import { JOIN_NOTE_MAX_CHARS } from "../../api/join";
import { defineText } from "../../i18n/core";
import en from "../../i18n/onboarding.en";
import id from "../../i18n/onboarding.id";

export const ONB = defineText(id, en);

export const STEP = ONB.step;
export const NAME_STEP = ONB.name;
export const SEARCH_GRACE = ONB.search.grace;
export const OFFICE_STEP = ONB.office;
export const WAITING = ONB.waiting;
export const ADMIN_IT = ONB.adminIt;
export const NEW_OFFICE = ONB.newOffice;
export const LEGACY = ONB.legacy;

// Fungsi, bukan salinan fungsi kamus, supaya selalu memakai bahasa aktif.
export const CHECKING_FIREWALL = (name: string) => ONB.firewall.checking(name);
export const FIREWALL_LEAD = (name: string) => ONB.firewall.lead(name);
export const FIREWALL_INVITE_LEAD = (name: string) => ONB.firewall.inviteLead(name);

// Hitungan karakter keterangan baru tampil kalau sisa 15 karakter atau kurang.
export const NOTE_COUNT_FROM = JOIN_NOTE_MAX_CHARS - 15;
