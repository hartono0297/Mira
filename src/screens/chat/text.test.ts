import { describe, expect, it } from "vitest";
import { budi, channel, dm, message, ME, penguji, sari } from "./conversationTestData";
import {
  baseName,
  conversationTitle,
  dayLabel,
  deliveryLine,
  fileKind,
  filterMembers,
  formatSize,
  formatTime,
  groupMessages,
  mentionQuery,
  mentionsInText,
  mergeMessages,
  messagePreview,
  scopeLabel,
  segmentMentions,
} from "./text";

const local = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).toISOString();

describe("waktu dan hari", () => {
  it("jam lokal dengan titik", () => {
    expect(formatTime(local(2026, 11, 23, 9, 5))).toBe("09.05");
    expect(formatTime(local(2026, 11, 23, 17, 40))).toBe("17.40");
    expect(formatTime("bukan tanggal")).toBe("");
  });

  it("Hari ini, Kemarin, lalu nama hari dan tanggal", () => {
    const now = new Date(2026, 10, 23, 10, 0);
    expect(dayLabel(local(2026, 11, 23, 8), now)).toBe("Hari ini");
    expect(dayLabel(local(2026, 11, 22, 23, 59), now)).toBe("Kemarin");
    expect(dayLabel(local(2026, 11, 16, 9), now)).toBe("Senin, 16 November 2026");
    expect(dayLabel(local(2026, 1, 1, 9), now)).toBe("Kamis, 1 Januari 2026");
  });
});

describe("ukuran dan jenis file", () => {
  it("format Indonesia dengan koma", () => {
    expect(formatSize(800)).toBe("800 byte");
    expect(formatSize(12 * 1024)).toBe("12 KB");
    expect(formatSize(1.2 * 1024 * 1024)).toBe("1,2 MB");
    expect(formatSize(5 * 1024 * 1024)).toBe("5 MB");
    expect(formatSize(3.4 * 1024 * 1024 * 1024)).toBe("3,4 GB");
  });

  it("jenis dari mime atau ekstensi", () => {
    expect(fileKind("application/pdf", "a.pdf")).toBe("pdf");
    expect(fileKind("image/png", "a.png")).toBe("image");
    expect(fileKind("application/octet-stream", "laporan.xlsx")).toBe("excel");
    expect(fileKind("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "a.docx")).toBe("word");
    expect(fileKind("application/zip", "a.zip")).toBe("archive");
    expect(fileKind("", "catatan.txt")).toBe("other");
  });

  it("nama file dari path Windows", () => {
    expect(baseName("C:\\Users\\Uji\\Dokumen\\kontrak.pdf")).toBe("kontrak.pdf");
    expect(baseName("/home/uji/foto.jpg")).toBe("foto.jpg");
  });
});

describe("judul dan cakupan", () => {
  it("channel memakai #, chat pribadi memakai nama rekan", () => {
    expect(conversationTitle(channel())).toBe("#proyek-a");
    expect(conversationTitle(dm())).toBe("Sari Uji");
  });

  it("label cakupan", () => {
    expect(scopeLabel(channel({ scope: { kind: "org", id: null, name: "Kantor" } }))).toBe("Seluruh kantor");
    expect(scopeLabel(channel({ scope: { kind: "team", id: "t", name: "Keuangan" } }))).toBe("Tim Keuangan");
    expect(scopeLabel(channel())).toBe("Proyek Gedung A");
    expect(scopeLabel(dm())).toBe("Chat pribadi");
  });
});

describe("mention", () => {
  it("memecah teks dan menandai mention saya", () => {
    const segs = segmentMentions("Tolong @Sari Uji dan @penguji cek ya", [sari, penguji], ME);
    expect(segs).toEqual([
      { kind: "text", text: "Tolong " },
      { kind: "mention", text: "@Sari Uji", person: sari, isMe: false },
      { kind: "text", text: " dan " },
      { kind: "mention", text: "@penguji", person: penguji, isMe: true },
      { kind: "text", text: " cek ya" },
    ]);
  });

  it("tidak cocok di tengah kata yang lebih panjang", () => {
    const sar = { publicKey: "x", name: "Sar" };
    expect(segmentMentions("@Sari datang", [sar], ME)).toEqual([{ kind: "text", text: "@Sari datang" }]);
  });

  it("nama terpanjang menang", () => {
    const short = { publicKey: "x", name: "Sari" };
    const segs = segmentMentions("@Sari Uji", [short, sari], ME);
    expect(segs).toEqual([{ kind: "mention", text: "@Sari Uji", person: sari, isMe: false }]);
  });

  it("anggota yang disebut di teks", () => {
    expect(mentionsInText("Halo @Budi Uji, kabari @Sari Uji.", [penguji, sari, budi])).toEqual([sari, budi]);
    expect(mentionsInText("tanpa mention", [sari])).toEqual([]);
  });

  it("mendeteksi @ yang sedang diketik", () => {
    expect(mentionQuery("Halo @Sa", 8)).toEqual({ start: 5, query: "Sa" });
    expect(mentionQuery("@", 1)).toEqual({ start: 0, query: "" });
    expect(mentionQuery("email@kantor", 12)).toBeNull();
    expect(mentionQuery("@Sa\nlagi", 8)).toBeNull();
    expect(mentionQuery("tanpa", 5)).toBeNull();
  });

  it("saran mention tanpa saya, awalan lebih dulu", () => {
    expect(filterMembers([penguji, sari, budi], "", ME)).toEqual([sari, budi]);
    expect(filterMembers([penguji, sari, budi], "uji", ME)).toEqual([sari, budi]);
    expect(filterMembers([penguji, sari, budi], "bu", ME)).toEqual([budi]);
  });
});

describe("pengelompokan", () => {
  it("pemisah hari dan pesan berurutan dalam 5 menit", () => {
    const now = new Date(2026, 10, 23, 12, 0);
    const items = groupMessages(
      [
        message({ id: "1", at: local(2026, 11, 22, 9, 0) }),
        message({ id: "2", at: local(2026, 11, 23, 9, 0) }),
        message({ id: "3", at: local(2026, 11, 23, 9, 4) }),
        message({ id: "4", at: local(2026, 11, 23, 9, 10) }),
        message({ id: "5", at: local(2026, 11, 23, 9, 11), author: budi }),
      ],
      now,
    );
    expect(items.map((i) => (i.kind === "day" ? i.label : `${i.message.id}${i.grouped ? "+" : ""}`))).toEqual([
      "Kemarin",
      "1",
      "Hari ini",
      "2",
      "3+",
      "4",
      "5",
    ]);
  });

  it("menggabung pesan lama tanpa duplikat", () => {
    const merged = mergeMessages([message({ id: "a" }), message({ id: "b", text: "lama" })], [
      message({ id: "b", text: "baru" }),
      message({ id: "c" }),
    ]);
    expect(merged.map((m) => `${m.id}:${m.text}`)).toEqual(["a:Halo semua", "b:baru", "c:Halo semua"]);
  });
});

describe("status kirim", () => {
  const status = (s: Partial<{ state: "pending" | "deposited" | "delivered" | "read"; read: number; delivered: number; deposited: number; total: number }>) => ({
    state: "pending" as const,
    read: 0,
    delivered: 0,
    deposited: 0,
    total: 5,
    ...s,
  });

  it("chat pribadi memakai label status", () => {
    expect(deliveryLine(status({ state: "delivered", total: 1, delivered: 1 }), "dm")).toEqual({
      icon: "delivered",
      text: "Diterima laptopnya",
    });
    expect(deliveryLine(status({ state: "deposited", total: 1 }), "dm")?.text).toBe("Dititipkan");
  });

  it("channel memakai jumlah", () => {
    expect(deliveryLine(status({ read: 2, delivered: 3 }), "channel")?.text).toBe("Dibaca 2 dari 5");
    expect(deliveryLine(status({ delivered: 3 }), "channel")?.text).toBe("Diterima 3 dari 5");
    expect(deliveryLine(status({ deposited: 2 }), "channel")?.text).toBe("Dititipkan");
    expect(deliveryLine(status({}), "channel")?.text).toBe("Menunggu");
    expect(deliveryLine(status({ total: 0 }), "channel")).toBeNull();
  });
});

describe("cuplikan", () => {
  it("memotong teks panjang dan menandai pesan dihapus", () => {
    expect(messagePreview(message({ text: "a".repeat(100) }), 10)).toBe("aaaaaaa...");
    expect(messagePreview(message({ deleted: true, text: "" }))).toBe("Pesan dihapus");
    expect(messagePreview(message({ text: "" , files: [{ hash: "h", name: "x.pdf", size: 1, mime: "", state: "local", autoDownload: true }] }))).toBe("x.pdf");
  });
});
