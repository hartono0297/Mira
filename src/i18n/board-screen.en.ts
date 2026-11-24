import type { Dict } from "./core";
import { plural } from "./core";
import type id from "./board-screen.id";

const en: Dict<typeof id> = {
  layar: {
    judul: "Board",
    navLabel: "My tasks and projects",
    taskSaya: "My tasks",
    proyek: "Projects",
    memuatProyek: "Loading projects...",
    belumAdaProyek: "No projects yet.",
    proyekBaru: "New project",
    catatanBuat: "A superadmin or a department admin creates projects.",
    artiTenggat: "tasks due today or overdue",
    belumSelesaiSr: (n: number) => ` ${plural(n, "task", "tasks")} not done`,
    keluarSr: (code: string, name: string) => `You left project ${code} ${name}.`,
    hilangSr: (code: string, name: string) => `Project ${code} ${name} is no longer available.`,
    keluarJudul: (code: string, name: string) => `You left project ${code} ${name}`,
    hilangJudul: (code: string, name: string) => `Project ${code} ${name} is no longer available`,
    keluarIsi: "This project no longer shows on your board, and this laptop has stopped receiving its new data.",
    hilangIsi: "You can't open this project anymore. Usually that's because a project manager removed you from it.",
    mintaTambah: "If you still need it, ask a project manager to add you again.",
    bukaProyek: (code: string, name: string) => `Open ${code} ${name}`,
    daftarBelumTerbaca: "Couldn't read the project list",
    intiTanpaDaftar: "The Mira core didn't send the project list.",
    tungguDaftar: "Wait a moment, then try again. Board data is stored on this laptop, so nothing is lost.",
    cobaLagi: "Try again",
    memuatBoard: "Loading board...",
    kosongJudul: "No projects yet",
    kosongJudulTamu: "No projects you can see yet",
    kosongIsi:
      "Each project has one board with the columns To do, In progress, and Done. Tasks are numbered from the project code, for example PA-1 for a project with the code PA.",
    buatPertama: "Create the first project",
    munculSetelahDitambah: "A project's board shows up here once its manager adds you as a member.",
  },

  board: {
    tidakBerizinPindah: (code: string) => `You don't have permission to move ${code}`,
    sudahTidakAda: (code: string) => `${code} is no longer on this board`,
    belumDipindah: (code: string) => `${code} not moved`,
    belumDipindahSr: (code: string) => `${code} not moved.`,
    dipindah: (code: string, column: string, pos: number, size: number) =>
      `${code} moved to ${column}, position ${pos} of ${size}.`,
    dikembalikan: "The card is back where it was.",
    keKolom: (column: string) => `To ${column}`,
    namaDiubah: (name: string) => `Project renamed to ${name}.`,
    dibuat: (code: string, column: string) => `${code} created in ${column}.`,
    tidakDitemukan: "This project wasn't found",
    belumTerbaca: "Couldn't read the board",
    intiTanpaBoard: "The Mira core didn't send the board data.",
    pilihLain: "Choose another project from the list on the left.",
    tungguBoard: "Wait a moment, then try again. The data is stored on this laptop, so nothing is lost.",
    departemenSr: "Project department: ",
    jumlahTask: (total: number, open: number) => `${total} ${plural(total, "task", "tasks")}, ${open} not done`,
    anggota: "Members",
    anggotaLabel: (n: number) => `Members, ${n} ${plural(n, "person", "people")}`,
    ubahNama: "Rename project",
    pintasan: "Keyboard shortcuts",
    taskBaru: "New task",
    hanyaLihat:
      "This board is view-only. You can open tasks and read their comments, but you can't add, move, or change anything.",
    pintasanLihat:
      "Select a card with Tab, then press Enter to open its details. Shift + F10 or the Menu key opens the card actions menu, same as right-click.",
    pintasanUbah:
      "Select a card with Tab, then press Enter to open its details. Alt + left or right arrow moves the card to the next column, Alt + up or down arrow changes its order. The four-way arrow button on a card opens the same options. Shift + F10 or the Menu key opens the card actions menu, same as right-click.",
    jumlahKolomSr: (n: number) => ` ${plural(n, "task", "tasks")}`,
    kolomKosong: "No tasks in this column yet.",
  },

  tambah: {
    judulKosong: "Write a task title first.",
    buka: "Add task",
    label: (column: string) => `New task title in ${column}`,
    placeholder: "Task title",
    petunjuk: "Enter saves. Escape closes, and your text is still there when you open it again.",
    tidakBerizin: "You don't have permission to create tasks in this project",
    belumDibuat: "Task not created",
    tutup: "Close",
    menyimpan: "Saving...",
    simpan: "Save",
  },

  luar: {
    proyekDepartemen: (team: string) => `${team} project`,
    tanpaDepartemen: "Project without a department",
    sub: (creator: string, members: number) => `created by ${creator}, ${members} ${plural(members, "member", "members")}`,
    sudahAnggota: (label: string) => `You're now a member of ${label}.`,
    sudahAnggotaTunggu: (label: string) =>
      `You're now a member of ${label}. The board appears once a project member's laptop connects.`,
    judul: "Other projects",
    catatan: "Projects you haven't joined. As a superadmin, you can join them yourself.",
    belumTerbaca: "Couldn't read the other projects.",
    cobaLagi: "Try again",
    gabungLabel: (label: string) => `Join this project: ${label}`,
    gabungTombol: "Join this project",
    gabungJudul: (label: string) => `Join ${label}?`,
    gabungJudulCadangan: "Join this project?",
    gabung: "Join",
    bergabung: "Joining...",
    belumBergabung: "You haven't joined",
    gabungIsi:
      "You'll become a member of this project. The organization log records this step, and all members can see it.",
    boardMenyusul: "The board appears once a project member's laptop connects.",
  },

  saya: {
    memuat: "Loading your tasks...",
    belumTerbaca: "Couldn't read your tasks",
    intiTanpaDaftar: "The Mira core didn't send the task list.",
    cobaBacaLagi: "Try reading it again. If it still fails, close Mira and open it again.",
    cobaLagi: "Try again",
    kosongJudul: "No tasks for you yet.",
    kosongIsi: "Tasks assigned to you on project boards will show up here.",
    semuaSelesai: "All your tasks are done.",
    judul: "My tasks",
    sub: "Tasks assigned to you, gathered from every project.",
  },
};

export default en;
