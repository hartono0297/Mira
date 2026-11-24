// Teks menu klik kanan dan tombol "..." di layar Chat (v0.4). Isinya di kamus
// src/i18n/chat-menu.id.ts dan chat-menu.en.ts; MENU selalu mengikuti bahasa aktif.
import en from "../../i18n/chat-menu.en";
import id from "../../i18n/chat-menu.id";
import { defineText } from "../../i18n/core";

export const MENU = defineText(id, en);
