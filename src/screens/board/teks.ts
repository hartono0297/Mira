// Teks antarmuka board, dikumpulkan di kamus src/i18n/board*.id.ts dan .en.ts.
// Berkas ini titik masuknya:
// - TEKS di bawah: kartu board, durasi, nama kolom dan prioritas, tanggal,
//   kelompok Task saya, riwayat aktivitas;
// - TEKS_LAYAR: layar Board, board proyek, tambah task, Proyek lain, Task saya;
// - teksDialog.ts: dialog detail task (properti, tenggat, label, Lainnya, tab);
// - teksSubtask.ts: daftar subtask;
// - teksWaktu.ts: timer dan bagian Waktu;
// - teksMenu.ts: menu klik kanan board.
// Semuanya diekspor ulang dari sini dan selalu membaca bahasa aktif. Kalimat
// yang memuat angka ditulis sebagai fungsi kecil.
import { defineText } from "../../i18n/core";
import en from "../../i18n/board.en";
import id from "../../i18n/board.id";
import screenEn from "../../i18n/board-screen.en";
import screenId from "../../i18n/board-screen.id";

export const TEKS = defineText(id, en);

export const TEKS_LAYAR = defineText(screenId, screenEn);

export * from "./teksDialog";
export * from "./teksMenu";
export * from "./teksSubtask";
export * from "./teksWaktu";
