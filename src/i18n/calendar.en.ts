import type { Dict } from "./core";
import type id from "./calendar.id";

const en: Dict<typeof id> = {
  judul: "Calendar",
  sebelumnya: {
    month: "Previous month",
    week: "Previous week",
    agenda: "Previous month",
  },
  berikutnya: {
    month: "Next month",
    week: "Next week",
    agenda: "Next month",
  },
  hariIni: "Today",
  tampilan: "View",
  namaTampilan: {
    month: "Month",
    week: "Week",
    agenda: "Agenda",
  },
  lihat: "Show",
  taskSaya: "My tasks",
  semuaProyek: "All projects",
  opsiProyek: (code: string, name: string) => `${code} · ${name}`,
  tampilkanSelesai: "Show completed",
  petunjuk: "Drag a task to another date, or press Alt+Arrow on the selected task.",
  memuat: "Loading tasks...",
  belumTerbaca: "Calendar tasks could not be read",
  intiTanpaData: "The Mira core did not send the task list.",
  dataLama: "You are seeing the last data that was read.",
  cobaLagi: "Try again",
  periode: (title: string) => `Showing ${title}.`,
  dipindah: (code: string, day: string) => `Due date of ${code} moved to ${day}.`,
  dihapus: (code: string) => `Due date of ${code} removed.`,
  gagalUbah: (code: string) => `Due date of ${code} was not changed`,
  tanpaHakTenggat: "You are not allowed to change the due date of this task.",
  menu: {
    label: (code: string) => `Move due date of ${code} to`,
    hariIni: "Today",
    besok: "Tomorrow",
    seninDepan: "Next Monday",
    lebihAwal: "One day earlier",
    lebihLambat: "One day later",
    hapus: "Remove due date",
    buka: "Open task",
    tanpaHak: "You are not allowed to change this task",
    sudahDiTanggal: "The due date is already on this date",
  },
};

export default en;
