// Teks dialog detail task (v0.4, arah A di design/v04-detail-task.html).
// Isinya ada di kamus src/i18n/board-dialog.id.ts dan .en.ts; objek di sini
// selalu membaca bahasa aktif. Kalimat yang memuat angka atau nama ditulis
// sebagai fungsi kecil.
import { defineText } from "../../i18n/core";
import en from "../../i18n/board-dialog.en";
import id from "../../i18n/board-dialog.id";

export { MAX_LABEL_LEN, MAX_LABELS } from "../../i18n/board-dialog.id";

export const TEKS_DIALOG = defineText(id.dialog, en.dialog);

export const teksDialog = defineText(id.kalimat, en.kalimat);
