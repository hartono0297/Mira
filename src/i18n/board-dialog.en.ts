import type { Dict } from "./core";
import { plural } from "./core";
import type id from "./board-dialog.id";
import { MAX_LABEL_LEN, MAX_LABELS } from "./board-dialog.id";

const en: Dict<typeof id> = {
  dialog: {
    // Kepala dialog
    tutup: "Close task details",
    lainnya: "More",
    hapusTask: "Delete task",
    judulDialogCadangan: "Task details",

    // Judul dan properti
    judul: "Title",
    komentar: "Comments",
    judulTask: "Task title",
    rincianTask: "Task details",
    status: "Status",
    penanggungJawab: "Assignee",
    tenggat: "Due date",
    prioritas: "Priority",
    label: "Labels",
    belumAda: "None yet",
    tanpaTenggat: "No due date",
    tanpaPenanggungJawab: "No assignee",
    tidakAdaLabel: "None",
    judulKosong: "The title can't be empty. Press Escape to go back to the previous title.",

    // Tenggat
    tanggalLain: "Another date",
    tanggalPlaceholder: "dd/mm/yyyy",
    pakai: "Use",
    tanggalPetunjuk: "Day/month/year, for example 27/11/2026.",
    tanggalKosong: "Enter a date first, for example 27/11/2026.",
    tanggalSalah: "That date wasn't recognized. Write day/month/year, for example 27/11/2026.",
    tanggalTidakAda: "That date isn't on the calendar. Check the day and month.",
    hariIni: "Today",
    besok: "Tomorrow",
    jumatIni: "This Friday",
    jumatDepan: "Next Friday",
    seninDepan: "Next Monday",

    // Label
    labelTask: "Task labels",
    labelBaru: "New label",
    labelBaruPlaceholder: "for example: structure",
    tambah: "Add",
    belumAdaLabelProyek: "This project has no labels yet. Write the first one below.",

    // Deskripsi
    deskripsi: "Description",
    deskripsiPlaceholder: "Add a description: what needs doing and what the result looks like",
    belumAdaDeskripsi: "No description yet.",
    simpanDeskripsi: "Save description",
    batalkanPerubahan: "Discard changes",
    ctrlEnterMenyimpan: "Ctrl+Enter also saves.",

    // Tab Komentar dan Aktivitas
    komentarDanAktivitas: "Comments and activity",
    tabKomentar: "Comments",
    tabAktivitas: "Activity",
    tulisKomentar: "Write a comment",
    ctrlEnterMengirim: "Ctrl+Enter to send.",
    kirim: "Send",
    mengirim: "Sending...",
    belumAdaKomentar: "No comments yet.",
    belumAdaKomentarTulis: "No comments yet. Write the first one below.",
    belumAdaAktivitas: "No activity yet.",
    aktivitasTerbaru: "Show only the latest",

    // Simpan dan error
    menyimpan: "Saving...",
    menghapus: "Deleting...",
    komentarTerkirim: "Comment sent.",
    subtaskBelumTersimpan: "Subtask not saved",
    waktuBelumTersimpan: "Time not saved",
    timerBelumTersimpan: "Timer not saved",
    taskBelumTerhapus: "Task not deleted",
    isianMasihAda: "What you typed is still here. Try again.",
    tidakBerizin: "You don't have permission for this",
    taskTidakAdaLagi: "This task no longer exists",
    komentarBelumTerkirim: "Comment not sent",

    // Memuat
    memuatTask: "Loading task...",
    taskBelumTerbaca: "Couldn't read the task",
    intiTidakMengirim: "The Mira core didn't send the task data.",
    mungkinSudahDihapus: "It may have been deleted. Close this dialog; the board already shows the latest list.",
    cobaBacaLagi: "Try reading it again. If it still fails, close Mira and open it again.",
    cobaLagi: "Try again",
    tutupSingkat: "Close",

    // Catatan di atas dokumen
    sudahDigabung: "Merged.",
    sudahDigabungIsi: "This task was also changed on another laptop, and the changes were merged automatically.",
    bisaKomentarSaja: "You can read and comment on this task, but you can't change it.",
    lihatSaja:
      "You can only view this task. Your role in this project doesn't allow changing or commenting on tasks.",
    deskripsiDiubahRekan:
      "This description was just changed on another laptop. Your text replaces it if you press Save description or close the dialog. Choose Discard changes or press Escape to use the latest version.",

    // Orang
    anda: "You",
    anggotaLain: "another member",

    // Task atau izinnya hilang
    goneTask: "This task was deleted on another laptop.",
    goneProject: "This task's project can't be opened anymore.",
    goneRevoked: "Your permission to change this task was just removed.",
    goneProjectSebab: "You no longer have access to this project, for example because you were removed from it.",
    goneAdaDraf: "Your unsaved text is still below. Copy it first if you still need it.",
    goneRevokedIsi: "You can still read the task, but changes can't be saved anymore.",
    goneIsiTerakhir: "Below is its last content. Changes can't be saved anymore.",
    drafJudul: "Your unsaved text",
    drafPetunjuk: "This text is lost once the dialog closes. Copy it first if you still need it.",

    // Menutup dengan isian yang belum tersimpan
    adaYangGagal: "Some changes aren't saved. Read the message below, then try saving again.",
    komentarBelumDikirim: "Your comment hasn't been sent.",
    ketikanBelumDisimpan: "Some of your typing hasn't been saved.",
    lanjutMengedit: "Keep editing",
    tutupTanpaMenyimpan: "Close without saving",
  },
  kalimat: {
    tersimpan: (field: string) => `${field} saved.`,
    belumTersimpan: (field: string) => `${field} not saved`,
    statusTersimpan: (column: string) => `Status saved: ${column}.`,
    semuaAktivitas: (n: number) => `Show all activity (${n})`,
    dibuatOleh: (who: string, when: string) => `Created by ${who}, ${when}`,
    sudahBanyakLabel: () => `Already ${MAX_LABELS} labels, the limit per task. Remove one to add a new one.`,
    petunjukLabel: () => `Up to ${MAX_LABELS} labels per task, ${MAX_LABEL_LEN} characters each.`,
    labelTerlaluPanjang: () => `A label can be at most ${MAX_LABEL_LEN} characters.`,
    labelSudahAda: (label: string) => `The label "${label}" already exists.`,
    judulDiubahRekan: (title: string) =>
      `This title was just changed on another laptop to "${title}". Your text replaces it if you press Enter, leave this field, or close the dialog. Press Escape to use that title.`,
    dataLama: (message: string) => `Couldn't read the latest data (${message}). Showing the last data loaded.`,
    // "Budi (you)", "Budi (no longer a project member)", "Budi (you, no longer a project member)".
    namaOrang: (name: string, mine: boolean, former = false) => {
      const notes = [mine ? "you" : "", former ? "no longer a project member" : ""].filter(Boolean);
      return notes.length > 0 ? `${name} (${notes.join(", ")})` : name;
    },
    sisaHari: (n: number) => {
      if (n === 0) return "today";
      if (n === 1) return "tomorrow";
      return n < 0 ? `${-n} ${plural(-n, "day", "days")} overdue` : `in ${n} days`;
    },
    hapusJudul: (code: string) => `Delete task ${code}?`,
    hapusTombol: (code: string) => `Delete ${code}`,
    hapusIsi: (title: string, subtasks: number, comments: number, entries: number) => {
      const parts = [
        subtasks > 0 ? `${subtasks} ${plural(subtasks, "subtask", "subtasks")}` : "",
        comments > 0 ? `${comments} ${plural(comments, "comment", "comments")}` : "",
        entries > 0 ? `${entries} ${plural(entries, "time entry", "time entries")}` : "",
      ].filter(Boolean);
      let also = "";
      if (parts.length === 1) also = ` and its ${parts[0]}`;
      else if (parts.length === 2) also = ` and its ${parts[0]} and ${parts[1]}`;
      else if (parts.length === 3) also = ` and its ${parts[0]}, ${parts[1]}, and ${parts[2]}`;
      return `"${title}"${also} will be removed from every project member's board and from My tasks. Mira can't bring it back.`;
    },
  },
};

export default en;
