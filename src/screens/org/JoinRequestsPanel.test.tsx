import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState, OrgInfo } from "../../api";
import type { JoinRequestView, OrgOverview } from "../../api/org";
import { appState, directory, router } from "../../test/fixtures";
import { adminOverview, joinRequest, memberOverview, overview, TEAM_2 } from "../../test/orgFixtures";
import { CARD_TEXT, ipGroup } from "./JoinRequestsPanel";
import { OrgScreen } from "./OrgScreen";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
// Tab lain diuji di filenya sendiri; di sini cukup kosong supaya tes ini hanya
// bergantung pada kerangka OrgScreen dan panel permintaan.
vi.mock("./UsersPanel", () => ({ UsersPanel: () => null }));
vi.mock("./PeoplePanel", () => ({ PeoplePanel: () => null }));
vi.mock("./DepartmentsPanel", () => ({ DepartmentsPanel: () => null }));
vi.mock("./LabelsPanel", () => ({ LabelsPanel: () => null }));

const state = appState() as AppState & { organization: OrgInfo };

type Handler = (args?: Record<string, unknown>) => unknown;

function setup(requests: JoinRequestView[] | Handler, o: OrgOverview = overview({ pendingJoinCount: 2 }), extra: Record<string, unknown> = {}) {
  invoke.mockImplementation(
    router({
      org_overview: o,
      get_directory: directory(),
      org_fingerprint: "ABCD-EFGH",
      org_join_requests: typeof requests === "function" ? requests : () => requests,
      ...extra,
    } as Parameters<typeof router>[0]),
  );
  render(<OrgScreen state={state} onRefresh={vi.fn()} />);
}

async function openTab() {
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: /Permintaan bergabung/ }));
  return user;
}

function card(name: string): HTMLElement {
  return screen.getByRole("heading", { name }).closest("li") as HTMLElement;
}

// Isi <dd> untuk label <dt> di kartu.
function fact(cardEl: HTMLElement, label: string): HTMLElement {
  const dt = within(cardEl).getByText(label, { selector: "dt" });
  return dt.nextElementSibling as HTMLElement;
}

function calls(cmd: string) {
  return invoke.mock.calls.filter(([c]) => c === cmd).map(([, args]) => args);
}

const RINA = joinRequest("r1", "Rina", {
  teamName: "Desain",
  laptop: "LAPTOP-DESAIN-03",
  ip: "192.168.1.23",
  os: "Windows 11 24H2",
  appVersion: "0.3.0",
  code: "4F2A 91C0",
  seenByName: "Andi",
  requestedAt: "2026-11-23T01:55:00Z",
  note: "Drafter baru di proyek Gedung B, nomor karyawan 0412.",
  account: "rina.w",
});
// Permintaan dari Mira v0.3: tanpa keterangan dan akun login.
const FAJAR = joinRequest("r2", "Fajar", {
  teamId: TEAM_2,
  teamName: "Drafting",
  laptop: "MacBook-Drafting-04",
  ip: null,
  os: "macOS 15.1",
  code: "7KQ2 X0M9",
  seenByName: null,
  requestedAt: "2026-11-22T00:00:00Z",
  note: null,
  account: null,
});

beforeEach(() => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  invoke.mockReset();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-23T02:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Permintaan bergabung: tampilan", () => {
  it("menunjukkan angka di tab dan isi kartu", async () => {
    setup([RINA, FAJAR]);
    const tab = await screen.findByRole("button", { name: /Permintaan bergabung/ });
    expect(tab).toHaveTextContent("2");
    expect(within(tab).getByText(/2 menunggu/)).toBeInTheDocument();
    await openTab();

    const rina = await screen.findByRole("heading", { name: "Rina" }).then((h) => h.closest("li") as HTMLElement);
    expect(within(rina).getByText("R")).toBeInTheDocument();
    expect(within(rina).getByText("5 menit lalu")).toBeInTheDocument();
    expect(within(rina).getByText(/Minta bergabung/)).toBeInTheDocument();
    expect(within(rina).getByText("Desain")).toBeInTheDocument();
    expect(within(rina).getByText("LAPTOP-DESAIN-03")).toHaveClass("mono");
    expect(within(rina).getByText("192.168.1.23")).toHaveClass("mono");
    expect(fact(rina, "Sistem")).toHaveTextContent("Windows 11 24H2");
    expect(fact(rina, "Versi Mira")).toHaveTextContent("0.3.0");
    // Akun login dan keterangan diisi oleh laptop peminta sendiri: labelnya
    // mengatakan itu, supaya admin tidak menganggapnya sudah diperiksa Mira.
    expect(CARD_TEXT.account).toBe("Akun login (dilaporkan laptop peminta)");
    expect(fact(rina, CARD_TEXT.account)).toHaveTextContent("rina.w");
    expect(fact(rina, CARD_TEXT.account)).toHaveClass("mono");
    // Label keterangan dibacakan sekali: figcaption memberi nama figure (browser
    // menurunkannya sendiri; jsdom belum), kutipannya tanpa nama sendiri.
    expect(CARD_TEXT.note).toBe("Keterangan dari peminta (belum diperiksa)");
    expect(within(rina).getAllByText(CARD_TEXT.note)).toHaveLength(1);
    const noteFigure = within(rina).getByRole("figure");
    expect(within(noteFigure).getByText(CARD_TEXT.note, { selector: "figcaption" })).toBeInTheDocument();
    const noteQuote = within(noteFigure).getByRole("blockquote");
    expect(noteQuote).toHaveTextContent("Drafter baru di proyek Gedung B, nomor karyawan 0412.");
    expect(noteQuote).not.toHaveAttribute("aria-labelledby");
    expect(noteQuote).toHaveAttribute("dir", "auto");
    expect(within(rina).getByText("4F2A 91C0")).toBeInTheDocument();
    expect(within(rina).getByText(CARD_TEXT.verifyHint)).toBeInTheDocument();
    // Petunjuk verifikasi tidak boleh mengarahkan admin ke nomor dari keterangan:
    // keterangan ditulis peminta, jadi bisa berisi nomor milik penipu.
    expect(CARD_TEXT.verifyHint).toBe(
      "Pastikan orangnya benar: telepon dia di nomor yang sudah Anda kenal, bukan nomor dari keterangan, atau datangi mejanya. Minta ia membacakan kode di layarnya, dan setujui hanya kalau kodenya sama.",
    );
    expect(within(rina).getByText("Diterima lewat laptop Andi")).toBeInTheDocument();

    const fajar = card("Fajar");
    expect(within(fajar).getByText("kemarin")).toBeInTheDocument();
    expect(within(fajar).getByText("Drafting")).toBeInTheDocument();
    expect(within(fajar).getByText("Tidak tercatat")).toBeInTheDocument();
    // Mira v0.3 tidak mengirim keterangan dan akun: tanpa label kosong.
    expect(within(fajar).queryByText(CARD_TEXT.note)).not.toBeInTheDocument();
    expect(within(fajar).queryByRole("figure")).not.toBeInTheDocument();
    expect(within(fajar).queryByRole("blockquote")).not.toBeInTheDocument();
    expect(fact(fajar, CARD_TEXT.account)).toHaveTextContent("Tidak dikirim");
    expect(fact(fajar, CARD_TEXT.account)).not.toHaveClass("mono");
    expect(within(fajar).getByText(CARD_TEXT.verifyHint)).toBeInTheDocument();
    expect(within(fajar).getByText("7KQ2 X0M9")).toBeInTheDocument();
    expect(within(fajar).queryByText(/Diterima lewat laptop/)).not.toBeInTheDocument();

    // Urutan dari Rust dipertahankan.
    const names = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(names).toEqual(["Rina", "Fajar"]);
    // IP berbeda atau kosong: tidak ada tombol tolak massal.
    expect(screen.queryByRole("button", { name: /Tolak semua dari/ })).not.toBeInTheDocument();
  });

  it("keterangan tampil sebagai teks apa adanya; keterangan kosong dan akun kosong ditangani", async () => {
    const tricky = joinRequest("r3", "Dewi", {
      note: '<img src=x onerror="alert(1)"> ' + "A".repeat(300),
      account: "  ",
    });
    const blank = joinRequest("r4", "Eko", { note: "   ", account: "eko" });
    setup([tricky, blank]);
    await openTab();

    const dewi = await screen.findByRole("heading", { name: "Dewi" }).then((h) => h.closest("li") as HTMLElement);
    const quote = within(within(dewi).getByRole("figure")).getByRole("blockquote");
    expect(quote).toHaveTextContent('<img src=x onerror="alert(1)">');
    expect(quote.querySelector("img")).toBeNull();
    expect(quote).toHaveClass("req-note-text");
    // Akun dikirim tapi kosong: bukan versi lama.
    expect(fact(dewi, CARD_TEXT.account)).toHaveTextContent("Tidak tercatat");

    const eko = card("Eko");
    expect(within(eko).queryByText(CARD_TEXT.note)).not.toBeInTheDocument();
    expect(fact(eko, CARD_TEXT.account)).toHaveTextContent("eko");
  });

  it("akun tidak dikirim: tertulis netral, tanpa menebak alasannya dari versi yang dilaporkan peminta", async () => {
    const without = (id: string, name: string, appVersion: string) =>
      joinRequest(id, name, { appVersion, note: null, account: null, ip: null });
    setup([without("v1", "Gita", "0.3.9"), without("v2", "Hadi", "0.4.0"), without("v3", "Kiki", "versi-uji")]);
    await openTab();
    await screen.findByRole("heading", { name: "Gita" });

    expect(CARD_TEXT.accountNotSent).toBe("Tidak dikirim");
    for (const name of ["Gita", "Hadi", "Kiki"]) {
      expect(fact(card(name), CARD_TEXT.account).textContent).toBe(CARD_TEXT.accountNotSent);
    }
    expect(screen.queryByText(/versi lama/)).not.toBeInTheDocument();
  });

  it("memuat", async () => {
    setup(() => new Promise(() => {}));
    await openTab();
    expect(screen.getByText("Memuat permintaan bergabung...")).toBeInTheDocument();
  });

  it("kosong untuk superadmin menyebut asal permintaan dan tab Undangan", async () => {
    setup([], overview());
    await openTab();
    expect(await screen.findByText("Tidak ada permintaan yang menunggu.")).toBeInTheDocument();
    expect(screen.getByText(/laptop baru di jaringan kantor memilih organisasi ini\./)).toBeInTheDocument();
    expect(screen.getByText(/kode dari tab Undangan/)).toBeInTheDocument();
    expect(screen.queryByText(/departemen Anda/)).not.toBeInTheDocument();
  });

  it("admin departemen melihat tab ini dan diberi tahu bahwa hanya departemennya yang tampil", async () => {
    setup([], adminOverview({ pendingJoinCount: 0 }));
    const tab = await screen.findByRole("button", { name: /Permintaan bergabung/ });
    expect(tab).not.toHaveTextContent(/\d/);
    await openTab();
    expect(await screen.findByText("Tidak ada permintaan yang menunggu.")).toBeInTheDocument();
    expect(screen.getByText(/Anda hanya melihat permintaan ke departemen Anda/)).toBeInTheDocument();
    expect(screen.getByText(/memilih organisasi ini dan departemen Anda/)).toBeInTheDocument();
  });

  it("anggota biasa tidak melihat tab Permintaan bergabung", async () => {
    setup([RINA], memberOverview());
    expect(await screen.findByRole("button", { name: "Anggota" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Permintaan bergabung/ })).not.toBeInTheDocument();
    expect(calls("org_join_requests")).toHaveLength(0);
  });

  it("error, lalu Coba lagi memuat ulang", async () => {
    let fail = true;
    setup(() => {
      if (fail) throw { code: "db", message: "Basis data terkunci." };
      return [RINA];
    });
    const user = await openTab();
    expect(await screen.findByText("Permintaan bergabung belum terbaca")).toBeInTheDocument();
    expect(screen.getByText("Basis data terkunci.")).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole("button", { name: "Coba lagi" }));
    expect(await screen.findByRole("heading", { name: "Rina" })).toBeInTheDocument();
    expect(screen.queryByText("Permintaan bergabung belum terbaca")).not.toBeInTheDocument();
  });
});

describe("Permintaan bergabung: Setujui dan Tolak", () => {
  it("Setujui memanggil org_approve_join dan menyebut nama serta departemen", async () => {
    let list = [RINA, FAJAR];
    setup(() => list, undefined, {
      org_approve_join: () => {
        list = [FAJAR];
        return null;
      },
    });
    const user = await openTab();
    await screen.findByRole("heading", { name: "Rina" });
    await user.click(screen.getByRole("button", { name: "Setujui permintaan Rina" }));
    expect(invoke).toHaveBeenCalledWith("org_approve_join", { requestId: "r1" });
    expect(await screen.findByText("Rina disetujui dan masuk departemen Desain.")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Rina" })).not.toBeInTheDocument());
    // Fokus tidak jatuh ke body: pindah ke Setujui di kartu berikutnya.
    await waitFor(() => expect(screen.getByRole("button", { name: "Setujui permintaan Fajar" })).toHaveFocus());
  });

  it("menyetujui permintaan terakhir memindahkan fokus ke judul tab", async () => {
    let list = [RINA];
    setup(() => list, undefined, {
      org_approve_join: () => {
        list = [];
        return null;
      },
    });
    const user = await openTab();
    await screen.findByRole("heading", { name: "Rina" });
    await user.click(screen.getByRole("button", { name: "Setujui permintaan Rina" }));
    expect(await screen.findByText("Tidak ada permintaan yang menunggu.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("heading", { name: "Permintaan bergabung", level: 2 })).toHaveFocus());
  });

  it("menampilkan error Rust saat menyetujui", async () => {
    setup([RINA], undefined, {
      org_approve_join: () => {
        throw { code: "join_request_expired", message: "Permintaan ini sudah lebih dari 7 hari dan kedaluwarsa." };
      },
    });
    const user = await openTab();
    await screen.findByRole("heading", { name: "Rina" });
    await user.click(screen.getByRole("button", { name: "Setujui permintaan Rina" }));
    expect(await screen.findByText("Permintaan belum disetujui")).toBeInTheDocument();
    expect(screen.getByText("Permintaan ini sudah lebih dari 7 hari dan kedaluwarsa.")).toBeInTheDocument();
  });

  it("Tolak meminta konfirmasi; Escape membatalkan, konfirmasi memanggil org_reject_join", async () => {
    let list = [RINA, FAJAR];
    setup(() => list, undefined, {
      org_reject_join: () => {
        list = [FAJAR];
        return null;
      },
    });
    const user = await openTab();
    await screen.findByRole("heading", { name: "Rina" });

    const open = screen.getByRole("button", { name: "Tolak permintaan Rina" });
    await user.click(open);
    let dialog = screen.getByRole("dialog", { name: "Tolak permintaan Rina?" });
    expect(within(dialog).getByText(/tidak bisa disetujui lagi/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Batal" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(open).toHaveFocus();
    expect(calls("org_reject_join")).toHaveLength(0);

    await user.click(open);
    dialog = screen.getByRole("dialog", { name: "Tolak permintaan Rina?" });
    await user.click(within(dialog).getByRole("button", { name: "Tolak Rina" }));
    expect(invoke).toHaveBeenCalledWith("org_reject_join", { requestId: "r1" });
    expect(await screen.findByText(/Permintaan Rina ditolak/)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Rina" })).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole("button", { name: "Setujui permintaan Fajar" })).toHaveFocus());
  });

  it("error Rust saat menolak tampil di dialog, dan dialog tetap terbuka", async () => {
    setup([RINA], undefined, {
      org_reject_join: () => {
        throw { code: "join_already_decided", message: "Permintaan ini sudah diputuskan." };
      },
    });
    const user = await openTab();
    await screen.findByRole("heading", { name: "Rina" });
    await user.click(screen.getByRole("button", { name: "Tolak permintaan Rina" }));
    const dialog = screen.getByRole("dialog", { name: "Tolak permintaan Rina?" });
    await user.click(within(dialog).getByRole("button", { name: "Tolak Rina" }));
    expect(await within(dialog).findByText("Permintaan belum ditolak")).toBeInTheDocument();
    expect(within(dialog).getByText("Permintaan ini sudah diputuskan.")).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Tolak permintaan Rina?" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Tolak Rina" })).toBeEnabled();
  });
});

describe("Permintaan bergabung: Tolak semua dari alamat ini", () => {
  const IP = "192.168.1.77";
  const A = joinRequest("a1", "Tamu Satu", { ip: IP });
  const B = joinRequest("b2", "Tamu Dua", { ip: IP, teamName: "Drafting" });
  const C = joinRequest("c3", "Tamu Tiga", { ip: IP });
  const OTHER = joinRequest("o4", "Rina", { ip: "192.168.1.23" });

  it("hanya muncul untuk IP dengan dua permintaan atau lebih, dan menolak permintaan IP itu saja", async () => {
    let list = [A, OTHER, B];
    setup(() => list, undefined, {
      org_reject_join: (args?: Record<string, unknown>) => {
        list = list.filter((r) => r.id !== args?.requestId);
        return null;
      },
    });
    const user = await openTab();
    await screen.findByRole("heading", { name: "Rina" });

    expect(within(card("Rina")).queryByRole("button", { name: /Tolak semua dari/ })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: `Tolak semua dari ${IP} (2)` })).toHaveLength(2);

    await user.click(within(card("Tamu Satu")).getByRole("button", { name: `Tolak semua dari ${IP} (2)` }));
    const dialog = screen.getByRole("dialog", { name: `Tolak 2 permintaan dari ${IP}?` });
    expect(within(dialog).getByText("Tamu Satu")).toBeInTheDocument();
    expect(within(dialog).getByText("Tamu Dua")).toBeInTheDocument();
    expect(within(dialog).queryByText("Rina")).not.toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Tolak 2 permintaan" }));
    expect(await screen.findByText(`2 permintaan dari ${IP} ditolak.`)).toBeInTheDocument();
    expect(calls("org_reject_join")).toEqual([{ requestId: "a1" }, { requestId: "b2" }]);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Tamu Satu" })).not.toBeInTheDocument());
    expect(screen.getByRole("heading", { name: "Rina" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Setujui permintaan Rina" })).toHaveFocus());
  });

  it("mengelompokkan IPv6 per /64: dua alamat berbeda dalam /64 yang sama ditolak bersama", async () => {
    const V1 = joinRequest("v1", "Enam Satu", { ip: "2001:db8:1:2::10" });
    const V2 = joinRequest("v2", "Enam Dua", { ip: "2001:0db8:0001:0002:abcd:0:0:5" });
    const V3 = joinRequest("v3", "Enam Tiga", { ip: "2001:db8:1:3::7" });
    let list = [V1, V3, V2];
    setup(() => list, undefined, {
      org_reject_join: (args?: Record<string, unknown>) => {
        list = list.filter((r) => r.id !== args?.requestId);
        return null;
      },
    });
    const user = await openTab();
    await screen.findByRole("heading", { name: "Enam Satu" });

    const label = "Tolak semua dari 2001:db8:1:2::/64 (2)";
    expect(within(card("Enam Satu")).getByRole("button", { name: label })).toBeInTheDocument();
    expect(within(card("Enam Dua")).getByRole("button", { name: label })).toBeInTheDocument();
    expect(within(card("Enam Tiga")).queryByRole("button", { name: /Tolak semua dari/ })).not.toBeInTheDocument();
    // Kartu tetap menampilkan alamat lengkapnya.
    expect(within(card("Enam Dua")).getByText("2001:0db8:0001:0002:abcd:0:0:5")).toBeInTheDocument();

    await user.click(within(card("Enam Dua")).getByRole("button", { name: label }));
    const dialog = screen.getByRole("dialog", { name: "Tolak 2 permintaan dari 2001:db8:1:2::/64?" });
    expect(within(dialog).getByText("2001:db8:1:2::10")).toBeInTheDocument();
    expect(within(dialog).queryByText("Enam Tiga")).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Tolak 2 permintaan" }));

    expect(await screen.findByText("2 permintaan dari 2001:db8:1:2::/64 ditolak.")).toBeInTheDocument();
    expect(calls("org_reject_join")).toEqual([{ requestId: "v1" }, { requestId: "v2" }]);
    await waitFor(() => expect(screen.getByRole("button", { name: "Setujui permintaan Enam Tiga" })).toHaveFocus());
  });

  it("menampilkan kemajuan di tombol konfirmasi", async () => {
    const waiting: (() => void)[] = [];
    setup([A, B], undefined, {
      org_reject_join: () => new Promise((resolve) => waiting.push(() => resolve(null))),
    });
    const user = await openTab();
    await screen.findByRole("heading", { name: "Tamu Satu" });
    await user.click(within(card("Tamu Satu")).getByRole("button", { name: /Tolak semua dari/ }));
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Tolak 2 permintaan" }));

    expect(await within(dialog).findByRole("button", { name: "Menolak 1 dari 2..." })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Batal" })).toBeDisabled();
    // Kartu tidak bisa dipakai selama penolakan berjalan.
    expect(screen.getAllByRole("button", { name: /Setujui permintaan/, hidden: true })[0]).toBeDisabled();
    waiting.shift()?.();
    expect(await within(dialog).findByRole("button", { name: "Menolak 2 dari 2..." })).toBeInTheDocument();
    waiting.shift()?.();
    expect(await screen.findByText(`2 permintaan dari ${IP} ditolak.`)).toBeInTheDocument();
  });

  it("berhenti pada kegagalan pertama dan melaporkan berapa yang sudah ditolak", async () => {
    setup([A, B, C], undefined, {
      org_reject_join: (args?: Record<string, unknown>) => {
        if (args?.requestId === "b2") throw { code: "forbidden", message: "Anda bukan admin departemen Drafting." };
        return null;
      },
    });
    const user = await openTab();
    await screen.findByRole("heading", { name: "Tamu Satu" });
    await user.click(within(card("Tamu Satu")).getByRole("button", { name: `Tolak semua dari ${IP} (3)` }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Tolak 3 permintaan" }));

    const dialog = await screen.findByRole("dialog", { name: `Tolak 2 permintaan dari ${IP}?` });
    expect(within(dialog).getByText("Gagal menolak permintaan Tamu Dua")).toBeInTheDocument();
    expect(within(dialog).getByText("Anda bukan admin departemen Drafting.")).toBeInTheDocument();
    expect(within(dialog).getByText(/Sebelum berhenti, 1 dari 3 permintaan sudah ditolak\./)).toBeInTheDocument();
    expect(calls("org_reject_join")).toEqual([{ requestId: "a1" }, { requestId: "b2" }]);
    // Sisanya (yang gagal dan sesudahnya) bisa ditolak lagi.
    expect(within(dialog).getByRole("button", { name: "Tolak 2 permintaan" })).toBeEnabled();
    expect(within(dialog).queryByText("Tamu Satu")).not.toBeInTheDocument();
  });

  it("melewati permintaan yang sudah diputuskan orang lain dan menghitungnya terpisah", async () => {
    setup([A, B, C], undefined, {
      org_reject_join: (args?: Record<string, unknown>) => {
        if (args?.requestId === "b2") throw { code: "join_already_decided", message: "Sudah diputuskan." };
        return null;
      },
    });
    const user = await openTab();
    await screen.findByRole("heading", { name: "Tamu Satu" });
    await user.click(within(card("Tamu Satu")).getByRole("button", { name: /Tolak semua dari/ }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Tolak 3 permintaan" }));

    expect(
      await screen.findByText(`2 permintaan dari ${IP} ditolak. 1 lainnya sudah diputuskan orang lain lebih dulu.`),
    ).toBeInTheDocument();
    expect(calls("org_reject_join")).toEqual([{ requestId: "a1" }, { requestId: "b2" }, { requestId: "c3" }]);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("ipGroup (sama dengan ip_group di join_store.rs)", () => {
  it("IPv4 apa adanya, IPv6 per /64, IPv4 dalam IPv6 menjadi IPv4", () => {
    expect(ipGroup("192.168.1.77")).toBe("192.168.1.77");
    expect(ipGroup("2001:db8:1:2::10")).toBe("2001:db8:1:2::/64");
    expect(ipGroup("2001:0DB8:0001:0002:abcd:0:0:5")).toBe("2001:db8:1:2::/64");
    expect(ipGroup("::1")).toBe("0:0:0:0::/64");
    expect(ipGroup("fe80::1%12")).toBe("fe80:0:0:0::/64");
    expect(ipGroup("::ffff:192.168.1.5")).toBe("192.168.1.5");
    expect(ipGroup("64:ff9b::192.168.1.5")).toBe("64:ff9b:0:0::/64");
  });

  it("tulisan yang tidak terbaca dikelompokkan persis", () => {
    expect(ipGroup("bukan-alamat")).toBe("bukan-alamat");
    expect(ipGroup("1:2:3")).toBe("1:2:3");
    expect(ipGroup("1::2::3")).toBe("1::2::3");
  });
});
