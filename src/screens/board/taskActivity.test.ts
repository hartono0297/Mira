import { describe, expect, it } from "vitest";
import { activitySentence } from "./taskActivity";

const ME = "a".repeat(64);
const SARI = { publicKey: "b".repeat(64), name: "Sari" };

describe("activitySentence renumbered", () => {
  it("menjelaskan nomor lama yang bentrok", () => {
    expect(activitySentence({ at: "t", actor: SARI, kind: "renumbered", detail: "PA-12" }, ME)).toBe(
      "Sari mengganti nomor task ini dari PA-12 karena nomornya sama dengan task lain",
    );
  });

  it("tanpa detail tetap terbaca, dan pelaku laptop ini jadi Anda", () => {
    const me = { publicKey: ME, name: "Rina" };
    expect(activitySentence({ at: "t", actor: me, kind: "renumbered", detail: "" }, ME)).toBe(
      "Anda mengganti nomor task ini",
    );
  });
});

describe("activitySentence subtask dan waktu (v0.4)", () => {
  const me = { publicKey: ME, name: "Rina" };

  it("subtask memakai judulnya dalam tanda kutip", () => {
    expect(activitySentence({ at: "t", actor: me, kind: "subtask_added", detail: "Ukur ulang dinding" }, ME)).toBe(
      'Anda menambahkan subtask "Ukur ulang dinding"',
    );
    expect(activitySentence({ at: "t", actor: SARI, kind: "subtask_done", detail: "Kirim PDF" }, ME)).toBe(
      'Sari menyelesaikan subtask "Kirim PDF"',
    );
    expect(activitySentence({ at: "t", actor: SARI, kind: "subtask_reopened", detail: "Kirim PDF" }, ME)).toBe(
      'Sari membuka lagi subtask "Kirim PDF"',
    );
    expect(activitySentence({ at: "t", actor: me, kind: "subtask_deleted", detail: "Cek tangga" }, ME)).toBe(
      'Anda menghapus subtask "Cek tangga"',
    );
  });

  it("subtask tanpa judul tetap terbaca", () => {
    expect(activitySentence({ at: "t", actor: SARI, kind: "subtask_added", detail: " " }, ME)).toBe(
      "Sari menambahkan subtask",
    );
  });

  it("time_logged menulis durasi dari detik", () => {
    expect(activitySentence({ at: "t", actor: me, kind: "time_logged", detail: "5400" }, ME)).toBe(
      "Anda mencatat 1 jam 30 menit",
    );
    expect(activitySentence({ at: "t", actor: SARI, kind: "time_logged", detail: "2700" }, ME)).toBe(
      "Sari mencatat 45 menit",
    );
    expect(activitySentence({ at: "t", actor: SARI, kind: "time_logged", detail: "3600" }, ME)).toBe(
      "Sari mencatat 1 jam",
    );
    expect(activitySentence({ at: "t", actor: SARI, kind: "time_logged", detail: "20" }, ME)).toBe(
      "Sari mencatat kurang dari 1 menit",
    );
  });

  it("time_logged dengan detail rusak tidak menampilkan angka asal", () => {
    expect(activitySentence({ at: "t", actor: SARI, kind: "time_logged", detail: "abc" }, ME)).toBe(
      "Sari mencatat waktu",
    );
  });
});
