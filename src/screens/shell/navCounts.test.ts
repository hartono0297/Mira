import { describe, expect, it } from "vitest";
import type { MyTask, TaskCard } from "../../api/board";
import { boardDue, chatUnread, joinPending, signWaiting } from "./navCounts";

function conv(extra: { unread?: unknown; muted?: unknown; archived?: unknown }) {
  return { archived: false, muted: false, unread: 0, ...extra };
}

function task(projectId: string, extra: Partial<TaskCard>): MyTask {
  return {
    projectId,
    projectCode: "PRJ",
    projectName: "Proyek Uji",
    task: {
      id: `t-${Math.random()}`,
      code: "PRJ-1",
      title: "Task uji",
      columnId: "todo",
      assignee: null,
      due: null,
      priority: "none",
      labels: [],
      commentCount: 0,
      merged: false,
      ...extra,
    },
  };
}

describe("chatUnread", () => {
  it("menjumlahkan unread percakapan aktif", () => {
    expect(chatUnread({ conversations: [conv({ unread: 2 }), conv({ unread: 3 })] })).toBe(5);
  });

  it("mengabaikan yang diarsipkan dan yang dibisukan", () => {
    const overview = {
      conversations: [conv({ unread: 2 }), conv({ unread: 7, archived: true }), conv({ unread: 4, muted: true })],
    };
    expect(chatUnread(overview)).toBe(2);
  });

  it("menganggap nilai rusak atau hilang sebagai nol", () => {
    const overview = {
      conversations: [conv({ unread: Number.NaN }), conv({ unread: "3" }), conv({ unread: -1 }), null, conv({ unread: 1 })],
    };
    expect(chatUnread(overview)).toBe(1);
    expect(chatUnread(null)).toBe(0);
    expect(chatUnread(undefined)).toBe(0);
    expect(chatUnread({})).toBe(0);
    expect(chatUnread({ conversations: null })).toBe(0);
  });

  it("tetap jalan kalau bentuk overview bertambah", () => {
    const overview = { conversations: [{ ...conv({ unread: 4 }), mentionUnread: 1, pinned: true }], extra: 1 };
    expect(chatUnread(overview)).toBe(4);
  });
});

describe("signWaiting", () => {
  it("hanya menghitung permintaan berjalan yang menunggu giliran saya", () => {
    const overview = {
      requests: [
        { status: "in_progress", myState: "your_turn" },
        { status: "in_progress", myState: "waiting_others" },
        { status: "completed", myState: "your_turn" },
        { status: "cancelled", myState: "your_turn" },
        { status: "in_progress", myState: "your_turn" },
      ],
    };
    expect(signWaiting(overview)).toBe(2);
  });

  it("nol untuk data kosong atau rusak", () => {
    expect(signWaiting(null)).toBe(0);
    expect(signWaiting({})).toBe(0);
    expect(signWaiting({ requests: [null] })).toBe(0);
  });
});

describe("boardDue", () => {
  const today = "2026-11-23";

  it("menghitung task tenggat hari ini atau lewat yang belum selesai", () => {
    const tasks = [
      task("p1", { due: "2026-11-23" }),
      task("p1", { due: "2026-11-01" }),
      task("p2", { due: "2026-11-24" }),
      task("p2", { due: "2026-11-20", columnId: "done" }),
      task("p2", { due: null }),
    ];
    expect(boardDue(tasks, today)).toBe(2);
  });

  it("nol untuk data kosong atau rusak", () => {
    expect(boardDue(null, today)).toBe(0);
    expect(boardDue([], today)).toBe(0);
    expect(boardDue([null, { projectId: "p" }] as unknown as MyTask[], today)).toBe(0);
  });
});

describe("joinPending", () => {
  it("hanya untuk yang boleh memutuskan permintaan bergabung", () => {
    expect(joinPending({ pendingJoinCount: 3, decideJoinTeamIds: ["t1"] })).toBe(3);
    expect(joinPending({ pendingJoinCount: 3, decideJoinTeamIds: [] })).toBe(0);
  });

  it("nol untuk data kosong atau rusak", () => {
    expect(joinPending(null)).toBe(0);
    expect(joinPending({ pendingJoinCount: Number.NaN, decideJoinTeamIds: ["t1"] })).toBe(0);
    expect(joinPending({ pendingJoinCount: 2 })).toBe(0);
  });
});
