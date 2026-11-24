import type { Dict } from "./core";
import { plural } from "./core";
import type id from "./board.id";

const en: Dict<typeof id> = {
  kartu: {
    subtaskSr: (done: number, total: number) => `, ${done} of ${total} ${plural(total, "subtask", "subtasks")} done`,
    waktuSr: (durasi: string) => `, time logged ${durasi}`,
    timerBerjalanSr: ", timer running",
    untukSr: (name: string) => `, for ${name}`,
    tanpaPenanggungJawabSr: ", no assignee",
    tenggatSr: ", due ",
    prioritasSr: ", priority ",
    komentarSr: (n: number) => ` ${plural(n, "comment", "comments")}`,
    label: "Labels",
    digabung: "Changed while offline, merged",
  },

  waktu: {
    pendek: { hari: "d", jam: "h", menit: "m" },
    panjang: {
      hari: (n: number) => `${n} ${plural(n, "day", "days")}`,
      jam: (n: number) => `${n} ${plural(n, "hour", "hours")}`,
      menit: (n: number) => `${n} ${plural(n, "minute", "minutes")}`,
    },
    kurangDariSemenit: "<1m",
    kurangDariSemenitPanjang: "less than 1 minute",
    isian: {
      kosong: "Enter a duration first, for example 1h 30m.",
      tidakDikenali: "That duration wasn't recognized. Write for example 90, 1h 30m, 1:30, or 1.5h.",
      terlaluSingkat: "The shortest duration is 1 minute.",
      terlaluLama: "The longest duration is 24 hours (1440 minutes).",
    },
  },

  kolom: {
    todo: "To do",
    doing: "In progress",
    done: "Done",
  },

  prioritas: {
    none: "No priority",
    low: "Low",
    medium: "Medium",
    high: "High",
  },

  tanggal: {
    bulan: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
    hari: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
    hariPendek: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
    // "22 Nov, 09:12"
    tanggalJam: (date: string, hh: string, mm: string) => `${date}, ${hh}:${mm}`,
    hariIni: "Today",
    besok: "Tomorrow",
    terlambat: (n: number) => `${n} ${plural(n, "day", "days")} overdue`,
  },

  proyek: {
    namaKosong: "Enter a project name first.",
    namaAturan: "A project name must be 2 to 80 characters.",
    tanpaDepartemen: "No department",
    // "Finance department". Names that already say department stay as they are.
    departemen: (name: string) =>
      /^(departemen|department)\b|\bdepartment$/i.test(name) ? name : `${name} department`,
  },

  grup: {
    late: "Overdue",
    today: "Today",
    tomorrow: "Tomorrow",
    week: "Next 7 days",
    later: "Later",
    none: "No due date",
    done: "Done",
  },

  pindah: {
    kiri: (code: string) => `${code} is already in the first column.`,
    kanan: (code: string) => `${code} is already in the last column.`,
    atas: (code: string) => `${code} is already at the top.`,
    bawah: (code: string) => `${code} is already at the bottom.`,
    tombol: "Move",
    tombolLabel: (code: string) => `Move ${code}`,
  },

  aktivitas: {
    anda: "You",
    andaObjek: "you",
    anggotaLain: "another member",
    created: (who: string) => `${who} created this task`,
    title: (who: string, d: string) => (d ? `${who} changed the title to "${d}"` : `${who} changed the title`),
    description: (who: string) => `${who} changed the description`,
    moved: (who: string, column: string) => (column ? `${who} moved the task to ${column}` : `${who} moved the task`),
    assignee: (who: string, person: string) =>
      person ? `${who} assigned the task to ${person}` : `${who} cleared the assignee`,
    due: (who: string, date: string) => (date ? `${who} changed the due date to ${date}` : `${who} cleared the due date`),
    priority: (who: string, label: string) => `${who} changed the priority to ${label}`,
    labels: (who: string, d: string) => (d ? `${who} changed the labels to ${d}` : `${who} removed all labels`),
    deleted: (who: string) => `${who} deleted this task`,
    commented: (who: string) => `${who} added a comment`,
    renumbered: (who: string, d: string) =>
      d
        ? `${who} renumbered this task from ${d} because its number matched another task`
        : `${who} renumbered this task`,
    subtaskAdded: (who: string, d: string) => (d ? `${who} added subtask "${d}"` : `${who} added a subtask`),
    subtaskDone: (who: string, d: string) => (d ? `${who} completed subtask "${d}"` : `${who} completed a subtask`),
    subtaskReopened: (who: string, d: string) => (d ? `${who} reopened subtask "${d}"` : `${who} reopened a subtask`),
    subtaskDeleted: (who: string, d: string) => (d ? `${who} deleted subtask "${d}"` : `${who} deleted a subtask`),
    timeLogged: (who: string, text: string) => (text ? `${who} logged ${text}` : `${who} logged time`),
    other: (who: string, d: string) => (d ? `${who} changed the task: ${d}` : `${who} changed the task`),
  },

  aksiGagal: (label: string) => `${label} failed`,
};

export default en;
