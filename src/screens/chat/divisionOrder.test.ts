import { describe, expect, it } from "vitest";
import type { ConversationSummary } from "../../api/chat";
import { conversationMenuItems } from "./conversationMenu";
import { isDivisionChat, orderDivisionChats, withDivisionOrder } from "./divisionOrder";
import { groupConversations } from "./ListFormat";
import { summary, TEAM_1 } from "./testData";

const TEAM_2 = "6".repeat(32);

function deptChannel(id: string, name: string, team = TEAM_1, extra: Partial<ConversationSummary> = {}) {
  return summary(`ch:${id.repeat(32)}`, name, {
    section: "departemen",
    scope: { kind: "team", id: team, name: team === TEAM_1 ? "Uji" : "Kedua" },
    ...extra,
  });
}

function divisionChat(id: string, name: string, team = TEAM_1, extra: Partial<ConversationSummary> = {}) {
  return summary(`ch:${id.repeat(32)}`, name, {
    kind: "division",
    section: "departemen",
    scope: { kind: "team", id: team, name: team === TEAM_1 ? "Uji" : "Kedua" },
    divisionId: id.repeat(32),
    teamId: team,
    canArchive: false,
    canDelete: false,
    ...extra,
  });
}

const names = (list: ConversationSummary[]) => list.map((c) => c.name);

describe("isDivisionChat", () => {
  it("mengenali jenis division atau divisionId", () => {
    expect(isDivisionChat(divisionChat("a", "Mobile"))).toBe(true);
    expect(isDivisionChat(deptChannel("b", "it", TEAM_1, { divisionId: "c".repeat(32) }))).toBe(true);
    expect(isDivisionChat(deptChannel("b", "it"))).toBe(false);
    expect(isDivisionChat(deptChannel("b", "it", TEAM_1, { divisionId: null }))).toBe(false);
  });
});

describe("orderDivisionChats", () => {
  it("menaruh chat divisi tepat di bawah channel departemennya, urut nama", () => {
    const list = [
      divisionChat("a", "Web"),
      deptChannel("b", "it"),
      divisionChat("c", "mobile"),
      deptChannel("d", "it-santai"),
    ];
    expect(names(orderDivisionChats(list))).toEqual(["it", "it-santai", "mobile", "Web"]);
  });

  it("setiap departemen mendapat divisinya sendiri", () => {
    const list = [
      deptChannel("b", "it"),
      deptChannel("d", "keuangan", TEAM_2),
      divisionChat("a", "Pajak", TEAM_2),
      divisionChat("c", "Mobile"),
    ];
    expect(names(orderDivisionChats(list))).toEqual(["it", "Mobile", "keuangan", "Pajak"]);
  });

  it("chat divisi redup tetap di akhir bagian", () => {
    const list = [
      deptChannel("b", "it"),
      divisionChat("a", "Mobile"),
      divisionChat("c", "Lama", TEAM_1, { archived: true }),
      divisionChat("e", "Bekas", TEAM_1, { former: true }),
    ];
    expect(names(orderDivisionChats(list))).toEqual(["it", "Mobile", "Lama", "Bekas"]);
  });

  it("induknya channel aktif, bukan channel yang diarsipkan di akhir", () => {
    const list = [deptChannel("b", "it"), divisionChat("a", "Mobile"), deptChannel("d", "it-lama", TEAM_1, { archived: true })];
    expect(names(orderDivisionChats(list))).toEqual(["it", "Mobile", "it-lama"]);
  });

  it("tanpa channel departemen di daftar, chat divisi tetap di tempatnya", () => {
    const list = [divisionChat("a", "Web"), divisionChat("c", "Mobile", TEAM_2)];
    expect(names(orderDivisionChats(list))).toEqual(["Web", "Mobile"]);
  });

  it("teamId kosong memakai cakupan departemen", () => {
    const list = [divisionChat("a", "Mobile", TEAM_1, { teamId: null }), deptChannel("b", "it")];
    expect(names(orderDivisionChats(list))).toEqual(["it", "Mobile"]);
  });

  it("daftar tanpa chat divisi tidak berubah", () => {
    const list = [deptChannel("b", "it"), deptChannel("d", "it-santai")];
    expect(orderDivisionChats(list)).toBe(list);
  });

  it("withDivisionOrder hanya mengubah bagian Departemen", () => {
    const umum = summary(`ch:${"f".repeat(32)}`, "umum", { isUmum: true });
    const groups = withDivisionOrder(groupConversations([divisionChat("a", "Mobile"), umum, deptChannel("b", "it")]));
    expect(names(groups.departemen)).toEqual(["it", "Mobile"]);
    expect(names(groups.umum)).toEqual(["umum"]);
  });
});

describe("menu chat divisi", () => {
  const noop = async () => {};
  const handlers = {
    toggleMute: noop,
    rename: () => {},
    addPeople: () => {},
    leave: noop,
    toggleLock: noop,
    toggleArchive: noop,
    deleteChannel: noop,
  };
  const ids = (c: ConversationSummary) =>
    conversationMenuItems(c, handlers)
      .map((e) => (typeof e === "object" && e && "id" in e ? e.id : null))
      .filter(Boolean);

  it("hanya Bisukan, tanpa arsip, hapus, kunci, ganti nama, atau keluar", () => {
    expect(ids(divisionChat("a", "Mobile"))).toEqual(["mute"]);
  });

  it("tetap tanpa arsip dan hapus walau inti mengirim jenis channel atau grup", () => {
    const asChannel = deptChannel("a", "Mobile", TEAM_1, { divisionId: "a".repeat(32), canArchive: true, canDelete: true, canLock: true });
    const asGroup = summary(`gr:${"a".repeat(32)}`, "Mobile", { divisionId: "a".repeat(32) });
    expect(ids(asChannel)).toEqual(["mute"]);
    expect(ids(asGroup)).toEqual(["mute"]);
  });
});
