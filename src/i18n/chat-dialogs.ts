import { defineText } from "./core";
import en from "./chat-dialogs.en";
import id from "./chat-dialogs.id";
import profileEn from "./chat-profile.en";
import profileId from "./chat-profile.id";

// Teks dialog chat (channel, pesan pribadi, grup, notifikasi, pemilih orang, anggota proyek).
export const CHAT_DIALOGS = defineText(id, en);

// Teks dialog profil; diekspor ulang sebagai PROFILE dari ProfileDialog.tsx.
export const PROFILE = defineText(profileId, profileEn);
