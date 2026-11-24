// Objek teks layar Chat yang mengikuti bahasa aktif. MENU ada di src/screens/chat/menuText.ts.
import chatEn from "./chat.en";
import chatId from "./chat.id";
import textEn from "./chat-text.en";
import textId from "./chat-text.id";
import { defineText } from "./core";

export const CHAT = defineText(chatId, chatEn);
export const CHAT_TEXT = defineText(textId, textEn);
