import type { Dict } from "./core";
import { plural } from "./core";
import type id from "./board-menu.id";

const en: Dict<typeof id> = {
  kembali: "Back",

  kartu: {
    menu: (code: string) => `Actions for ${code}`,
    buka: "Open task",
    pindahkan: "Move to",
    pindahkanMenu: (code: string) => `Move ${code} to`,
    sudahDiKolom: "Task is already in this column",
    naik: "Move up one",
    turun: "Move down one",
    sudahAtas: "Already at the top",
    sudahBawah: "Already at the bottom",
    tugaskan: "Assign to",
    tugaskanMenu: (code: string) => `Assign ${code} to`,
    anda: (name: string) => `${name} (you)`,
    tanpaPenanggungJawab: "No assignee",
    penanggungJawabSekarang: "Current assignee",
    belumAdaPenanggungJawab: "No assignee yet",
    bukanAnggota: (name: string, mine: boolean) =>
      mine ? `${name} (you, no longer a project member)` : `${name} (no longer a project member)`,
    prioritas: "Change priority",
    prioritasMenu: (code: string) => `Priority of ${code}`,
    prioritasSekarang: "Current priority",
    tenggat: "Set due date",
    tenggatMenu: (code: string) => `Due date of ${code}`,
    hariIni: "Today",
    besok: "Tomorrow",
    tenggatSekarang: "Current due date",
    tanggalLain: "Another date in task details",
    hapusTenggat: "Clear due date",
    belumAdaTenggat: "No due date yet",
    mulaiTimer: "Start my timer",
    jedaTimer: "Pause my timer",
    lanjutkanTimer: "Resume my timer",
    salinKode: (code: string) => `Copy code ${code}`,
    hapus: "Delete task",
    hapusIsi: (title: string, subtasks: number, comments: number, waktu: boolean) => {
      const parts = [
        subtasks > 0 ? `${subtasks} ${plural(subtasks, "subtask", "subtasks")}` : "",
        comments > 0 ? `${comments} ${plural(comments, "comment", "comments")}` : "",
        waktu ? "time entries" : "",
      ].filter(Boolean);
      let also = "";
      if (parts.length === 1) also = ` and its ${parts[0]}`;
      else if (parts.length === 2) also = ` and its ${parts[0]} and ${parts[1]}`;
      else if (parts.length === 3) also = ` and its ${parts[0]}, ${parts[1]}, and ${parts[2]}`;
      return `"${title}"${also} will be removed from every project member's board and from My tasks. Mira can't bring it back.`;
    },
    dihapus: (code: string) => `${code} deleted.`,
    tanggalDengan: (label: string, date: string) => `${label}, ${date}`,
    disalin: (code: string) => `Code ${code} copied.`,
    gagalSalin: (code: string) => `Code ${code} not copied`,
    gagalSalinIsi: "The clipboard can't be used right now. Try again in a moment, or open the task to see its code.",
    ditugaskan: (code: string, name: string) => `${code} assigned to ${name}.`,
    dilepas: (code: string) => `${code} has no assignee.`,
    prioritasDiubah: (code: string, label: string) => `Priority of ${code}: ${label}.`,
    tenggatDiubah: (code: string, label: string) => `Due date of ${code}: ${label}.`,
    tenggatDihapus: (code: string) => `Due date of ${code} cleared.`,
    timerMulai: (code: string) => `Your timer on ${code} is running.`,
    timerLanjut: (code: string) => `Your timer on ${code} is running again.`,
    timerDijeda: (code: string) => `Your timer on ${code} is paused.`,
    gagal: (code: string) => `${code} not changed`,
  },

  kolom: {
    menu: (name: string) => `Actions for column ${name}`,
    taskBaru: (name: string) => `New task in ${name}`,
  },

  subtask: {
    menu: (title: string) => `Actions for subtask ${title}`,
    centang: "Mark as done",
    batalCentang: "Mark as not done",
    gantiNama: "Rename",
    tugaskan: "Assign to",
    tugaskanMenu: (title: string) => `Assign subtask ${title} to`,
    naik: "Move up one",
    turun: "Move down one",
    sudahAtas: "Already at the top",
    sudahBawah: "Already at the bottom",
    hapus: "Delete subtask",
    menunggu: "Wait for the previous change to save",
  },

  proyek: {
    menu: (code: string, name: string) => `Actions for project ${code} ${name}`,
    buka: "Open board",
    sedangTerbuka: "This board is already open",
    anggota: "Project members",
    ubahNama: "Rename project",
  },

  taskSaya: {
    menu: (code: string) => `Actions for ${code}`,
    buka: "Open task",
    pindahkan: "Move to",
    pindahkanMenu: (code: string) => `Move ${code} to`,
    salinKode: (code: string) => `Copy code ${code}`,
    dipindah: (code: string, column: string) => `${code} moved to ${column}.`,
    gagalPindah: (code: string) => `${code} not moved`,
    gagalSalinIsi: "The clipboard can't be used right now. Try again in a moment, or open the task to see its code.",
  },
};

export default en;
