import { defineText } from "./core";
import en from "./api.en";
import id from "./api.id";

// Teks bersama src/api. Label seperti ROLE_LABELS di src/api/types.ts membaca
// bagian objek ini, jadi selalu mengikuti bahasa aktif.
export const API_TEXT = defineText(id, en);
