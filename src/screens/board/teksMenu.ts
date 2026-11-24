// Teks menu klik kanan board (v0.4): kartu task, kolom, subtask, daftar
// proyek, dan Task saya. Isinya ada di kamus src/i18n/board-menu.id.ts dan
// .en.ts. Rancangan isi menu ada di docs/plans/v04-ctx-board.md.
import { defineText } from "../../i18n/core";
import en from "../../i18n/board-menu.en";
import id from "../../i18n/board-menu.id";

export const TEKS_MENU = defineText(id, en);
