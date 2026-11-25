# Rencana dan kontrak: sidebar ringkas dan menu Kalender

Tanggal: 24 November 2026. Branch `claude/sidebar-kalender-9e403d`, dari `main` a45d1b3 (v0.5.0).

Permintaan user: "side bar bisa di minimize", "ada menu kalender, user bisa lihat task2 per kalender gitu", dan "u atur yang terbaiknya gimana semua".

Enam sesi lain berjalan bersamaan (bergabung, chat-sticker, foto profil, dept-divisi, Kopi, timer). Kode sesi ini sebisa mungkin di file baru. `Shell.tsx` hanya disentuh sedikit.

## 1. Sidebar ringkas

**Penyimpanan.** Kunci pengaturan lokal `shell.sidebar` lewat `api.getSetting` / `api.setSetting` yang sudah ada (tabel `settings` di inti Rust, per laptop, per folder data). Nilai `"collapsed"` atau `"expanded"`, bawaan `"expanded"`. Tidak ada command Rust baru untuk ini. Salinan di localStorage (`mira.sidebar`) hanya untuk frame pertama, sama seperti tema dan bahasa.

**Hook `src/screens/shell/useSidebar.ts`.**
```ts
export const SIDEBAR_SETTING_KEY = "shell.sidebar";
export const SIDEBAR_CACHE_KEY = "mira.sidebar";
export const NARROW_QUERY = "(max-width: 899px)";
export function useSidebar(): {
  collapsed: boolean;      // yang tampil: pilihan user ATAU jendela sempit
  chosen: boolean;         // pilihan user yang tersimpan
  narrow: boolean;         // jendela < 900 px
  toggle: () => void;      // membalik yang tampil, menyimpan kalau tidak sempit
};
```
Aturan jendela sempit: di bawah 900 px sidebar otomatis ringkas. Menekan tombol di jendela sempit membuka sidebar lebar sementara (tidak disimpan). Begitu jendela lebar lagi, pilihan tersimpan berlaku.

**Pintasan.** Ctrl+B (Cmd+B di macOS) membalik sidebar dari mana pun, kecuali saat dialog modal terbuka (`[role=dialog][aria-modal=true]` ada di dokumen) atau event sudah `defaultPrevented`. Ctrl+B belum dipakai di aplikasi (dicek dengan grep `KeyB`, `"b"`).

**Tampilan ringkas (lebar 64 px).**
- Tombol ringkas/lebarkan di bawah logo, ikon `IconLayoutSidebarLeftCollapse` / `...Expand`, `aria-expanded`, `aria-controls` ke `<aside id="main-sidebar">`, label "Ringkas menu" / "Lebarkan menu", tooltip dengan pintasan.
- Menu: hanya ikon. Setiap tombol tetap punya nama aksesibel = label menu (+ arti angka). Tooltip muncul saat hover dan saat fokus keyboard (komponen `NavTooltip`, `role="tooltip"`, ditempatkan di kanan ikon, tidak menangkap pointer).
- Angka notifikasi: lencana kecil di pojok kanan atas ikon (angka, "99+" kalau besar). `UpdateDot` tetap titik.
- Panel jaringan: satu titik status (hijau terhubung, merah ada masalah, abu memeriksa) dengan tooltip dan nama aksesibel status jaringan. Klik membuka sidebar lebar sementara? Tidak: klik membuka Organisasi, sama seperti tautan di panel lebar.
- Profil: avatar saja, nama dan kantor jadi tooltip dan teks `sr-only`.
- Animasi lebar 160 ms `ease-out` pada `grid-template-columns`. `@media (prefers-reduced-motion: reduce)` mematikannya.

## 2. Menu Kalender

Posisi di sidebar: setelah Board. `Section` bertambah `"calendar"`. Ikon `IconCalendar`.

### 2.1 Inti Rust: `board_calendar`

File baru `src-tauri/src/board/calendar.rs`. `mod.rs` mendapat `pub mod calendar;`, `lib.rs` satu baris registrasi.

```rust
/// Live tasks with a due date in [from, to] (inclusive, YYYY-MM-DD; None = unbounded)
/// from every project the viewer may view, sorted by (due, project code, number).
pub fn calendar(state: &MiraState, from: Option<&str>, to: Option<&str>) -> AppResult<Vec<MyTask>>;

#[tauri::command]
pub async fn board_calendar(state: State<'_, MiraState>, from: Option<String>, to: Option<String>) -> AppResult<Vec<MyTask>>;
```
- Membaca `board_task_index` (`due IS NOT NULL AND deleted = 0`, rentang memakai perbandingan string karena format tetap) untuk mendapat proyek dan id task, lalu membuka dokumen per proyek sekali untuk membangun `TaskCard` lewat `Ctx::card`, sama seperti `my_tasks`.
- Akses: proyek yang `Ctx::can_view` gagal dilewati (Tamu hanya proyek undangannya, anggota hanya proyek yang ia anggotai, sama persis dengan Board).
- `from`/`to` divalidasi dengan `model::validate_due`. `from > to` = error input. Rentang lebih dari 400 hari = error input (mencegah permintaan besar tanpa sengaja; agenda lewat tenggat memakai `from = None`).
- Hak kartu (`canEdit`, `canDelete`) dihitung sekali per proyek seperti `my_tasks`.
- Tes unit di file itu: rentang inklusif, task tanpa tenggat dan terhapus tidak ikut, urutan, proyek bukan anggota tidak ikut, Tamu hanya proyek undangannya, `canEdit` false untuk Tamu, validasi rentang.

Ubah tenggat memakai command yang sudah ada: `boardApi.updateTask(projectId, taskId, { due })`. Inti Rust tetap memeriksa hak `EditTask`.

### 2.2 API web: `src/api/calendar.ts`

```ts
import type { MyTask } from "./board";
export type CalTask = MyTask; // { projectId, projectCode, projectName, task: TaskCard }
export const calendarApi = {
  tasks: (from: string | null, to: string | null) => call<CalTask[]>("board_calendar", { from, to }),
};
```
Pembaruan: `subscribeBoard` dari `src/api/board.ts` (board lokal, sinkron dari laptop lain, keanggotaan).

### 2.3 Logika murni: `src/screens/calendar/calendarModel.ts`

Semua tanggal adalah string `YYYY-MM-DD` waktu lokal. Tidak ada `Date` UTC di luar fungsi ini.
```ts
export type DayKey = string; // "2026-11-24"
export type CalView = "month" | "week" | "agenda";
export function todayKey(now?: Date): DayKey;
export function addDays(day: DayKey, n: number): DayKey;
export function addMonths(day: DayKey, n: number): DayKey;     // dijepit ke akhir bulan
export function startOfWeek(day: DayKey): DayKey;              // Senin
export function weekDays(day: DayKey): DayKey[];               // 7 hari Senin..Minggu
export function monthGrid(day: DayKey): DayKey[][];            // minggu-minggu (Senin) yang menutupi bulan; 4 sampai 6 baris
export function sameMonth(a: DayKey, b: DayKey): boolean;
export function rangeFor(view: CalView, anchor: DayKey): { from: DayKey; to: DayKey }; // month = sel grid pertama..terakhir; week = Senin..Minggu; agenda = tanggal 1..akhir bulan
export function groupByDay(tasks: CalTask[]): Map<DayKey, CalTask[]>; // urutan: belum selesai dulu, lalu prioritas tinggi, kode proyek, kode task
export type CalFilter = { scope: "mine" | "all" | { project: string }; showDone: boolean };
export function applyFilter(tasks: CalTask[], filter: CalFilter, me: string): CalTask[];
export function isOverdue(t: CalTask, today: DayKey): boolean; // tenggat < hari ini dan kolom bukan done
export function projectColors(projects: { id: string; code: string }[]): Map<string, number>; // indeks 0..7 menurut urutan kode, stabil
export function taskKey(t: CalTask): string; // `${projectId}/${task.id}`
export function canMoveDue(t: CalTask): boolean; // t.task.canEdit === true
// Format ikut bahasa (locale() dari i18n/core): judul bulan "November 2026", label hari "Sen", "Senin, 24 November 2026"
export function monthTitle(day: DayKey, lang?: Lang): string;
export function weekTitle(day: DayKey, lang?: Lang): string;   // "24 sampai 30 November 2026" / "24 to 30 November 2026"
export function weekdayShort(lang?: Lang): string[];           // 7 nama, Senin dulu
export function dayLong(day: DayKey, lang?: Lang): string;
export function dayNumber(day: DayKey): string;                // "24"
```
`me` = kunci publik saya: `scope: "mine"` menyaring `task.assignee?.publicKey === me`. Kunci publik saya dibaca dari `AppState.identity.publicKey` lewat prop `me` ke `CalendarScreen`.

### 2.4 Tampilan: `MonthView.tsx`, `WeekView.tsx`, `AgendaView.tsx`, `CalChip.tsx`, `DayMore.tsx`

Props bersama (`src/screens/calendar/viewTypes.ts`, ditulis lebih dulu oleh penanggung tampilan):
```ts
export type ChipHandlers = {
  onOpen: (t: CalTask) => void;
  onPointerDown: (e: React.PointerEvent<HTMLElement>, t: CalTask) => void;
  onContextMenu: (e: React.MouseEvent<HTMLElement>, t: CalTask) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLElement>, t: CalTask) => void; // Alt+Panah, Shift+F10, ContextMenu
};
export type ViewProps = ChipHandlers & {
  anchor: DayKey;
  today: DayKey;
  byDay: Map<DayKey, CalTask[]>;        // sudah disaring
  colors: Map<string, number>;          // projectId -> 0..7
  draggingKey: string | null;           // taskKey yang sedang diseret
  dropDay: DayKey | null;               // hari di bawah pointer saat seret
  focusKey: string | null;              // chip yang harus difokus setelah render (setelah pindah tenggat)
};
```
- Chip adalah `<button type="button">` dengan `data-cal-task={taskKey}`, warna proyek sebagai garis kiri + kode proyek tertulis (bukan hanya warna), kode task dan judul. Lewat tenggat: ikon `IconAlertTriangle` + teks sr "lewat tenggat" + gaya merah. Selesai: dicoret dan redup dengan ikon centang. Nama aksesibel lengkap: "TES-3, Laporan bulanan, proyek Tes, lewat tenggat, selesai".
- Sel hari punya `data-cal-day={day}` (target seret). Sel hari ini ditandai lingkaran aksen pada angka + `aria-current="date"`.
- Bulan: grid `role="grid"`? Tidak. Pakai tabel sederhana: `<table>` dengan `<th scope="col">` nama hari, setiap sel `<td>` berisi angka hari sebagai heading kecil dan daftar chip. Maks 3 chip per sel, sisanya tombol "+N lagi" yang membuka `DayMore` (popover daftar semua task hari itu, Esc menutup dan fokus kembali ke tombol). Hari di luar bulan redup.
- Minggu: 7 kolom, semua task tampil, kolom bergulir sendiri. Di jendela < 760 px kolom menumpuk jadi daftar per hari.
- Agenda: daftar per hari (`<section>` dengan `<h3>` tanggal panjang) hanya untuk hari yang ada task-nya, ditambah grup "Lewat tenggat" di atas berisi task belum selesai sebelum rentang kalau rentang memuat hari ini (prop tambahan `overdue: CalTask[]`). Kosong: kalimat "Tidak ada task bertenggat di bulan ini." dengan saran saringan.
- CSS di `calendar-views.css` (milik penanggung tampilan). Warna proyek `--cal-p0` sampai `--cal-p7` didefinisikan di sana untuk terang dan gelap (`[data-theme="dark"]`), dicek kontras 3:1 terhadap latar chip untuk garis dan 4.5:1 untuk teks kode proyek.

### 2.5 Layar: `CalendarScreen.tsx`, `useDueDrag.ts`, `useCalendarData.ts`, `DueMenu`

- Kepala: judul periode (`h1`, misalnya "November 2026"), tombol Sebelumnya/Berikutnya (label "Bulan sebelumnya"/"Minggu sebelumnya"), Hari ini, pilihan tampilan Bulan | Minggu | Agenda (grup tombol `aria-pressed`), saringan cakupan (`<select>`: Task saya, Semua proyek, lalu setiap proyek), kotak centang "Tampilkan yang selesai" (bawaan mati). Pilihan tampilan dan saringan disimpan di pengaturan lokal `calendar.view` dan `calendar.filter` (JSON) lewat `api.setSetting`, gagal simpan diabaikan.
- Data: `useCalendarData(view, anchor)` memanggil `calendarApi.tasks(range)`; untuk Agenda yang memuat hari ini juga `calendarApi.tasks(null, kemarin)` untuk grup lewat tenggat. Muat ulang saat `subscribeBoard` dan saat rentang berubah. Hasil lama tetap tampil selama memuat. Error tampil dengan `ErrorAlert` dan tombol Coba lagi.
- Daftar proyek untuk saringan dan warna: `boardApi.listProjects()`.
- Klik chip: membuka `TaskDetail` dari `src/screens/board/TaskDetail` (`projectId`, `taskId`, `onClose`, `onChanged` = muat ulang). Setelah tutup, fokus kembali ke chip.
- Seret: `useDueDrag` dengan pointer events (pola `useCardDrag.ts`: ambang 5 px, bayangan chip, klik setelah seret ditelan, Esc membatalkan, gulir otomatis di tepi area). Hanya chip dengan `canEdit`. Lepas di sel `data-cal-day` lain memanggil `updateTask({ due })`, tampil optimistis, gagal dikembalikan dan error diumumkan. Pengumuman `aria-live`: "Tenggat TES-3 dipindah ke Jumat, 28 November 2026."
- Alternatif keyboard: Alt+Panah kiri/kanan (±1 hari), Alt+Panah atas/bawah (±7 hari) pada chip yang boleh diubah; Shift+F10 / tombol Menu / klik kanan membuka menu "Pindahkan tenggat ke": Hari ini, Besok, Senin depan, Satu hari lebih awal, Satu hari lebih lambat, Hapus tenggat, lalu "Buka task". Tanpa hak: menu hanya "Buka task", item lain nonaktif dengan alasan "Anda tidak berhak mengubah task ini".
- CSS di `calendar.css`.

### 2.6 Kamus

- `src/i18n/shell.id.ts` / `.en.ts`: `nav.calendar`, `collapse`, `expand`, `shortcut`, `netDot` (milik penanggung sidebar).
- `src/i18n/calendar-view.id.ts` / `.en.ts` + `calendar-view.ts`: teks tampilan bulan/minggu/agenda/chip (milik penanggung tampilan).
- `src/i18n/calendar.id.ts` / `.en.ts` + `calendar.ts`: teks layar, saringan, seret, menu (milik penanggung layar).

## 3. Pembagian kerja paralel

| Agen | File milik | Tidak boleh disentuh |
|---|---|---|
| Rust | `src-tauri/src/board/calendar.rs`, satu baris di `board/mod.rs` dan `lib.rs` | file lain |
| Sidebar | `src/screens/shell/*` (Shell.tsx sekecil mungkin), `src/i18n/shell.*` | `src/screens/calendar/` |
| Model | `src/screens/calendar/calendarModel.ts` + tes, `src/api/calendar.ts` | tampilan |
| Tampilan | `viewTypes.ts`, `MonthView`, `WeekView`, `AgendaView`, `CalChip`, `DayMore`, `calendar-views.css`, `i18n/calendar-view.*` + tes | layar |
| Layar | `CalendarScreen.tsx`, `useDueDrag.ts`, `useCalendarData.ts`, `DueMenu.tsx`, `calendar.css`, `i18n/calendar.*` + tes | tampilan |
| e2e | `scripts/sidebar-kalender-e2e.mjs` | kode aplikasi |

Sidebar merender `<CalendarScreen me={state.identity.publicKey} />` dari `../calendar/CalendarScreen`.

## 4. Selesai berarti

`cargo test`, `cargo clippy --all-targets -- -D warnings`, `npx tsc --noEmit`, `npx vitest run` lulus. e2e baru lulus, `smoke-e2e`, `board-e2e`, `english-e2e`, `contextmenu-e2e` tetap lulus satu per satu. Screenshot di `docs/progress/screenshots/sidebar-kalender/`. Laporan `docs/progress/sidebar-kalender.md`.
