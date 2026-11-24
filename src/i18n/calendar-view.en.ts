import type { Dict } from "./core";
import { plural } from "./core";
import type id from "./calendar-view.id";

const en: Dict<typeof id> = {
  chip: {
    pemisahSr: ", ",
    proyekSr: (name: string) => `, project ${name}`,
    lewatSr: ", overdue",
    selesaiSr: ", done",
    untukSr: (name: string) => `, assigned to ${name}`,
    tanpaOrang: "Unassigned",
    tanpaOrangSr: ", unassigned",
    prioritasSr: (label: string) => `, ${label} priority`,
  },
  bulan: {
    lagi: (n: number) => `+${n} more`,
    hariSr: (day: string) => `, ${day}`,
    jumlahSr: (n: number) => ` ${plural(n, "task", "tasks")}`,
    adaLewatSr: ", some overdue",
  },
  daftarHari: {
    tutup: "Close list",
  },
  minggu: {
    kosong: "Nothing due",
  },
  agenda: {
    lewat: "Overdue",
    hariIni: "Today",
    kosongJudul: (month: string) => `No tasks are due in ${month}.`,
    kosongSaran: "Tasks without a due date do not appear in the calendar. Set a due date on the Board, or change the filter above.",
  },
};

export default en;
