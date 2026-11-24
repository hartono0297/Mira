import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState } from "../../api";
import { appState, firewall, org, router, rustError } from "../../test/fixtures";
import { ThemeProvider } from "../../theme/ThemeProvider";
import { device, office, outgoing, searchResult } from "./joinFixtures";
import { noteHasForbiddenChars } from "./OfficeStep";
import { Onboarding } from "./Onboarding";
import { GRACE_MS, SETUP_SEARCH_MS } from "./SearchStep";
import { OFFICE_STEP } from "./texts";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const NEW_OFFICE = /Siapkan Mira untuk kantor baru/;
const NOTE = "Keterangan untuk admin (opsional)";

function fresh(displayName: string | null = "Penguji"): AppState {
  const base = appState({ organization: null, membership: "none" });
  return { ...base, identity: { ...base.identity, displayName } };
}

function setup(state: AppState = fresh()) {
  const onOrganization = vi.fn();
  const onIdentity = vi.fn();
  render(
    <ThemeProvider>
      <Onboarding state={state} onIdentity={onIdentity} onOrganization={onOrganization} onReload={vi.fn()} />
    </ThemeProvider>,
  );
  return { onOrganization, onIdentity };
}

function commands(table: Parameters<typeof router>[0]) {
  invoke.mockImplementation(
    router({ get_firewall_status: firewall({ rule: "allowed" }), join_device: device, ...table }),
  );
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

// Pilihan kantor di kartu langkah. Pemilih bahasa di atas kartu juga berisi radio.
function officeRadios() {
  return within(screen.getByRole("main")).queryAllByRole("radio");
}

function calls(cmd: string) {
  return invoke.mock.calls.filter(([c]) => c === cmd);
}

function user() {
  return userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
}

// Langkah 1 (nama), lalu Lanjut.
async function passName(u: ReturnType<typeof user>) {
  expect(await screen.findByRole("heading", { name: "Siapa nama Anda?" })).toHaveFocus();
  expect(screen.getByText("Langkah 1 dari 3")).toBeInTheDocument();
  await u.click(screen.getByRole("button", { name: "Lanjut" }));
}

// Nama, firewall sudah mengizinkan Mira (dilewati), lalu mencari.
async function startSearch(u: ReturnType<typeof user>) {
  await passName(u);
  expect(await screen.findByRole("heading", { name: "Mencari kantor di jaringan..." })).toHaveFocus();
}

// Kantor ditemukan: pencarian masih menunggu GRACE_MS untuk kantor lain.
async function searchUntilFound(u: ReturnType<typeof user>, heading = "Kantor ditemukan: Biro Contoh") {
  await startSearch(u);
  await advance(GRACE_MS + 500);
  return screen.findByRole("heading", { name: heading });
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  invoke.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Onboarding: melanjutkan permintaan yang tersimpan", () => {
  it("permintaan menunggu: langsung ke layar menunggu tanpa langkah nama", async () => {
    commands({
      join_outgoing: outgoing({ note: "Staf desain, NIK 1042" }),
      join_poll: { status: "pending", request: outgoing() },
    });
    setup();

    expect(await screen.findByRole("heading", { name: "Menunggu persetujuan" })).toBeInTheDocument();
    expect(screen.getByText("Langkah 3 dari 3")).toBeInTheDocument();
    expect(screen.getByText("4F2A 91C0")).toBeInTheDocument();
    expect(screen.getByText("7KQ2-M9XD")).toBeInTheDocument();
    expect(await screen.findByText("LAPTOP-DESAIN-03")).toBeInTheDocument();
    expect(screen.getByText(/admin departemen Desain/)).toBeInTheDocument();
    const box = screen.getByText("Yang dilihat admin").closest(".onb-box") as HTMLElement;
    expect(within(box).getByText("Keterangan")).toBeInTheDocument();
    expect(within(box).getByText("Staf desain, NIK 1042")).toBeInTheDocument();
    expect(within(box).getByText("Akun login")).toBeInTheDocument();
    expect(within(box).getByText("desain03")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Siapa nama Anda?" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Izinkan Mira di jaringan kantor" })).not.toBeInTheDocument();
  });

  it("tanpa keterangan (bisa jadi bentuk v0.3): akun login tampil sebagai fakta laptop, di luar kotak admin", async () => {
    commands({ join_outgoing: outgoing(), join_poll: { status: "pending", request: outgoing() } });
    setup();
    expect(await screen.findByText("desain03")).toBeInTheDocument();
    const box = screen.getByText("Yang dilihat admin").closest(".onb-box") as HTMLElement;
    expect(within(box).queryByText("desain03")).not.toBeInTheDocument();
    expect(within(box).queryByText("Keterangan")).not.toBeInTheDocument();
    expect(screen.getByText("Akun login laptop ini")).toBeInTheDocument();
  });

  it("tanpa keterangan dan akun tidak terbaca: barisnya tidak tampil", async () => {
    invoke.mockImplementation(
      router({
        join_device: { ...device, account: null },
        join_outgoing: outgoing(),
        join_poll: { status: "pending", request: outgoing() },
      }),
    );
    setup();
    expect(await screen.findByText("LAPTOP-DESAIN-03")).toBeInTheDocument();
    expect(screen.queryByText("Keterangan")).not.toBeInTheDocument();
    expect(screen.queryByText("Akun login")).not.toBeInTheDocument();
    expect(screen.queryByText("Akun login laptop ini")).not.toBeInTheDocument();
  });

  it("permintaan ditolak: nama penolak dan waktunya", async () => {
    commands({
      join_outgoing: outgoing({ status: "rejected", decidedByName: "Andi", decidedAt: "2026-11-23T12:00:00Z" }),
    });
    setup();

    expect(await screen.findByRole("heading", { name: "Permintaan ditolak" })).toBeInTheDocument();
    expect(screen.getByText(/Andi menolak permintaan Anda untuk bergabung ke Biro Contoh/)).toBeInTheDocument();
    expect(screen.getByText(/23 November 2026/)).toBeInTheDocument();
    expect(screen.queryByText(/Langkah \d dari 3/)).not.toBeInTheDocument();
  });

  it("pesan pengiriman yang gagal tampil sebagai keterangan, bukan error", async () => {
    const req = outgoing({ lastSentAt: null, lastError: "Belum ada laptop anggota yang bisa dihubungi." });
    commands({ join_outgoing: req, join_poll: { status: "pending", request: req } });
    setup();

    expect(await screen.findByText("Belum ada laptop rekan yang menerima permintaan ini")).toBeInTheDocument();
    expect(screen.getByText("Belum ada laptop anggota yang bisa dihubungi.")).toBeInTheDocument();
    expect(document.querySelector(".alert")).toBeNull();
  });
});

describe("Onboarding: langkah nama", () => {
  it("nama sudah ada: Lanjut tanpa menyimpan ulang, lalu langsung mencari", async () => {
    const u = user();
    commands({ join_search: searchResult() });
    setup();

    expect(await screen.findByRole("heading", { name: "Siapa nama Anda?" })).toBeInTheDocument();
    expect(screen.getByLabelText("Nama tampilan")).toHaveValue("Penguji");
    expect(screen.getByText(/Rekan kerja melihat nama ini/)).toBeInTheDocument();
    await u.click(screen.getByRole("button", { name: "Lanjut" }));

    expect(await screen.findByRole("heading", { name: "Mencari kantor di jaringan..." })).toBeInTheDocument();
    expect(screen.getByText("Langkah 2 dari 3")).toBeInTheDocument();
    expect(calls("save_display_name")).toHaveLength(0);
    expect(calls("get_firewall_status")).toHaveLength(1);
  });

  it("nama belum ada: ditolak kalau kosong, lalu disimpan dan dipakai di formulir kantor", async () => {
    const u = user();
    const saved = { ...fresh().identity, displayName: "Rina" };
    commands({ join_search: searchResult({ offices: [office()] }), save_display_name: saved });
    const { onIdentity } = setup(fresh(null));

    expect(await screen.findByRole("heading", { name: "Siapa nama Anda?" })).toBeInTheDocument();
    expect(screen.getByLabelText("Nama tampilan")).toHaveValue("");
    await u.click(screen.getByRole("button", { name: "Lanjut" }));
    expect(await screen.findByText("Isi nama tampilan dulu.")).toBeInTheDocument();
    expect(screen.getByLabelText("Nama tampilan")).toHaveFocus();
    expect(screen.getByLabelText("Nama tampilan")).toHaveAttribute("aria-invalid", "true");
    expect(calls("save_display_name")).toHaveLength(0);

    await u.type(screen.getByLabelText("Nama tampilan"), "  Rina ");
    await u.click(screen.getByRole("button", { name: "Lanjut" }));
    await screen.findByRole("heading", { name: "Mencari kantor di jaringan..." });
    expect(invoke).toHaveBeenCalledWith("save_display_name", { name: "Rina" });
    expect(onIdentity).toHaveBeenCalledWith(saved);

    await advance(GRACE_MS + 500);
    await screen.findByRole("heading", { name: "Kantor ditemukan: Biro Contoh" });
    expect(screen.getByText("Rina")).toBeInTheDocument();
    expect(screen.queryByLabelText("Nama tampilan")).not.toBeInTheDocument();
  });

  it("nama gagal disimpan: pesan dari inti tampil dan tetap di langkah nama", async () => {
    const u = user();
    commands({ save_display_name: rustError("database", "Data tidak bisa disimpan.") });
    setup(fresh(null));
    await screen.findByRole("heading", { name: "Siapa nama Anda?" });
    await u.type(screen.getByLabelText("Nama tampilan"), "Rina");
    await u.click(screen.getByRole("button", { name: "Lanjut" }));
    expect(await screen.findByText("Nama belum tersimpan")).toBeInTheDocument();
    expect(screen.getByText("Data tidak bisa disimpan.")).toBeInTheDocument();
    expect(calls("join_search")).toHaveLength(0);
  });

  it("Ubah nama dari formulir kantor: kembali ke langkah 1, lalu ke formulir yang sama tanpa mencari ulang", async () => {
    const u = user();
    const saved = { ...fresh().identity, displayName: "Penguji Baru" };
    commands({ join_search: searchResult({ offices: [office()] }), save_display_name: saved });
    setup();
    await searchUntilFound(u);
    const searches = calls("join_search").length;

    await u.click(screen.getByRole("button", { name: "Ubah nama" }));
    expect(await screen.findByRole("heading", { name: "Siapa nama Anda?" })).toHaveFocus();
    await u.clear(screen.getByLabelText("Nama tampilan"));
    await u.type(screen.getByLabelText("Nama tampilan"), "Penguji Baru");
    await u.click(screen.getByRole("button", { name: "Lanjut" }));

    expect(await screen.findByRole("heading", { name: "Kantor ditemukan: Biro Contoh" })).toHaveFocus();
    expect(screen.getByText("Penguji Baru")).toBeInTheDocument();
    expect(calls("join_search")).toHaveLength(searches);
  });

  it("Ubah nama tidak menghapus isian kantor, departemen, keterangan, dan centang sidik", async () => {
    const u = user();
    commands({
      join_search: searchResult({
        offices: [
          office({ key: "a", fingerprint: "AAAA-1111", conflict: true }),
          office({ key: "b", fingerprint: "BBBB-2222", conflict: true }),
        ],
      }),
    });
    setup();
    await searchUntilFound(u, "Beberapa kantor ditemukan");
    await u.click(officeRadios()[1]);
    await u.selectOptions(screen.getByLabelText("Departemen"), "Desain");
    await u.type(screen.getByLabelText(NOTE), "Staf gudang");
    await u.click(screen.getByRole("checkbox", { name: /BBBB-2222/ }));

    await u.click(screen.getByRole("button", { name: "Ubah nama" }));
    await screen.findByRole("heading", { name: "Siapa nama Anda?" });
    await u.click(screen.getByRole("button", { name: "Lanjut" }));

    await screen.findByRole("heading", { name: "Beberapa kantor ditemukan" });
    expect(officeRadios()[1]).toBeChecked();
    expect(screen.getByLabelText("Departemen")).toHaveValue("t-des");
    expect(screen.getByLabelText(NOTE)).toHaveValue("Staf gudang");
    expect(screen.getByRole("checkbox", { name: /BBBB-2222/ })).toBeChecked();
  });

  it("mode --siapkan-kantor: mencari sebentar, tanpa kantor lalu kantor baru, Kembali ke cara lain", async () => {
    const u = user();
    commands({ join_setup_mode: true, join_search: searchResult() });
    setup();
    await passName(u);

    expect(await screen.findByRole("heading", { name: "Mencari kantor di jaringan..." })).toHaveFocus();
    expect(screen.getByText(/Sebelum menyiapkan kantor baru, Mira memeriksa/)).toBeInTheDocument();
    expect(screen.getByText("Pencarian berhenti sendiri setelah 6 detik.")).toBeInTheDocument();
    expect(screen.queryByText(/Langkah \d dari 3/)).not.toBeInTheDocument();
    await advance(SETUP_SEARCH_MS + 500);

    expect(await screen.findByRole("heading", { name: "Siapkan Mira untuk kantor baru" })).toHaveFocus();
    expect(calls("join_search").length).toBeGreaterThan(0);
    expect(calls("get_firewall_status")).toHaveLength(1);
    expect(screen.getByLabelText("Nama Anda")).toHaveValue("Penguji");

    await u.click(screen.getByRole("button", { name: "Kembali" }));
    expect(await screen.findByRole("heading", { name: "Cari kantor dengan cara lain" })).toHaveFocus();
  });

  it("mode --siapkan-kantor dengan aturan firewall belum ada: langkah firewall dulu, lalu kantor baru", async () => {
    const u = user();
    commands({ join_setup_mode: true, get_firewall_status: firewall({ rule: "missing" }), join_search: searchResult() });
    setup();
    await passName(u);

    expect(await screen.findByRole("heading", { name: "Izinkan Mira di jaringan kantor" })).toHaveFocus();
    await u.click(await screen.findByRole("button", { name: "Lewati, atur nanti" }));
    expect(await screen.findByRole("heading", { name: "Mencari kantor di jaringan..." })).toHaveFocus();
    await advance(SETUP_SEARCH_MS + 500);
    expect(await screen.findByRole("heading", { name: "Siapkan Mira untuk kantor baru" })).toHaveFocus();
  });

  it("Lanjut ditekan dua kali selagi mode siapkan kantor belum terjawab: lanjut sekali saja", async () => {
    const u = user();
    let answer: (v: boolean) => void = () => {};
    commands({
      join_setup_mode: () => new Promise<boolean>((r) => (answer = r)),
      join_search: searchResult(),
    });
    setup();
    await screen.findByRole("heading", { name: "Siapa nama Anda?" });
    const next = screen.getByRole("button", { name: "Lanjut" });
    await u.click(next);
    await u.click(next);
    await act(async () => answer(false));
    await screen.findByRole("heading", { name: "Mencari kantor di jaringan..." });
    expect(calls("get_firewall_status")).toHaveLength(1);
  });

  it("mode --siapkan-kantor gagal dibaca: alur biasa", async () => {
    const u = user();
    commands({ join_setup_mode: rustError("internal", "x"), join_search: searchResult() });
    setup();
    await startSearch(u);
  });
});

describe("Onboarding: kantor ditemukan", () => {
  it("satu kantor: terpilih otomatis dengan sidik, isi departemen, kirim permintaan, lalu layar menunggu", async () => {
    const u = user();
    commands({
      join_search: searchResult({ offices: [office()] }),
      join_send_request: outgoing({ displayName: "Penguji" }),
      join_poll: { status: "pending", request: outgoing() },
    });
    setup();

    const heading = await searchUntilFound(u);
    expect(heading).toHaveFocus();
    expect(screen.getByText("Langkah 2 dari 3")).toBeInTheDocument();
    expect(screen.getByText("7KQ2-M9XD")).toBeInTheDocument();
    expect(officeRadios()).toHaveLength(0);
    expect(screen.getByText("Penguji")).toBeInTheDocument();
    expect(screen.queryByLabelText("Nama tampilan")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Departemen")).toBeEnabled();
    expect(screen.queryByText(NEW_OFFICE)).not.toBeInTheDocument();

    await u.click(screen.getByRole("button", { name: "Kirim permintaan" }));
    expect(await screen.findByText("Pilih departemen Anda dulu.")).toBeInTheDocument();
    expect(calls("join_send_request")).toHaveLength(0);

    await u.selectOptions(screen.getByLabelText("Departemen"), "Desain");
    await u.click(screen.getByRole("button", { name: "Kirim permintaan" }));

    expect(await screen.findByRole("heading", { name: "Menunggu persetujuan" })).toHaveFocus();
    expect(invoke).toHaveBeenCalledWith("join_send_request", {
      officeKey: "org-biro:fp1",
      teamId: "t-des",
      confirmFingerprint: null,
      note: null,
      useAd: false,

    });
    expect(calls("save_display_name")).toHaveLength(0);
    expect(screen.getByText("4F2A 91C0")).toBeInTheDocument();
    expect(screen.getByText("7KQ2-M9XD")).toBeInTheDocument();
    expect(screen.getByText("Langkah 3 dari 3")).toBeInTheDocument();
  });

  it("keterangan untuk admin: dipangkas, paling banyak 80 karakter, hitungan baru tampil dekat batas", async () => {
    const u = user();
    commands({ join_search: searchResult({ offices: [office()] }), join_send_request: outgoing() });
    setup();
    await searchUntilFound(u);

    const note = screen.getByLabelText(NOTE);
    expect(note).toHaveAttribute("maxLength", "80");
    expect(document.getElementById(note.getAttribute("aria-describedby")!.split(" ")[1])).toHaveAttribute(
      "aria-live",
      "polite",
    );
    // Keterangan membantu admin mengenali orangnya, bukan bukti identitas.
    expect(OFFICE_STEP.noteHint).toBe(
      "Misalnya jabatan atau nomor karyawan, supaya admin lebih mudah mengenali Anda. Paling banyak 80 karakter.",
    );
    expect(screen.getByText(OFFICE_STEP.noteHint)).toBeInTheDocument();
    expect(screen.queryByText(/yakin ini Anda/)).not.toBeInTheDocument();
    await u.type(note, "a".repeat(90));
    expect(note).toHaveValue("a".repeat(80));
    expect(screen.getByText("80 dari 80 karakter")).toBeInTheDocument();

    await u.clear(note);
    expect(screen.queryByText(/dari 80 karakter/)).not.toBeInTheDocument();
    await u.type(note, "  Staf desain, NIK 1042  ");
    await u.selectOptions(screen.getByLabelText("Departemen"), "Desain");
    await u.click(screen.getByRole("button", { name: "Kirim permintaan" }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("join_send_request", {
        officeKey: "org-biro:fp1",
        teamId: "t-des",
        confirmFingerprint: null,
        note: "Staf desain, NIK 1042",
        useAd: false,

      }),
    );
  });

  it("hitungan keterangan memakai panjang yang sama dengan batas isian (emoji dihitung dua)", async () => {
    const u = user();
    commands({ join_search: searchResult({ offices: [office()] }) });
    setup();
    await searchUntilFound(u);
    await u.type(screen.getByLabelText(NOTE), "\u{1F600}".repeat(33));
    expect(screen.getByText("66 dari 80 karakter")).toBeInTheDocument();
  });

  it("keterangan dengan karakter kontrol atau bidi: ditolak sebelum dikirim", async () => {
    const u = user();
    commands({ join_search: searchResult({ offices: [office()] }), join_send_request: outgoing() });
    setup();
    await searchUntilFound(u);
    const note = screen.getByLabelText(NOTE);
    await u.type(note, "Staf\u202Edesain");
    await u.selectOptions(screen.getByLabelText("Departemen"), "Desain");
    await u.click(screen.getByRole("button", { name: "Kirim permintaan" }));
    expect(await screen.findByText("Keterangan berisi karakter yang tidak diizinkan.")).toBeInTheDocument();
    expect(note).toHaveFocus();
    expect(note).toHaveAttribute("aria-invalid", "true");
    expect(calls("join_send_request")).toHaveLength(0);
  });

  it("keterangan dengan karakter pengisi Hangul: ditolak sebelum dikirim", async () => {
    const u = user();
    commands({ join_search: searchResult({ offices: [office()] }), join_send_request: outgoing() });
    setup();
    await searchUntilFound(u);
    const note = screen.getByLabelText(NOTE);
    await u.type(note, "Staf\u{3164}desain");
    await u.selectOptions(screen.getByLabelText("Departemen"), "Desain");
    await u.click(screen.getByRole("button", { name: "Kirim permintaan" }));
    expect(await screen.findByText("Keterangan berisi karakter yang tidak diizinkan.")).toBeInTheDocument();
    expect(note).toHaveFocus();
    expect(calls("join_send_request")).toHaveLength(0);
  });

  it("pemeriksaan keterangan: karakter tak terlihat, pemilih varian, tag, dan tumpukan tanda gabung ditolak", () => {
    const rejected = [
      "a\u{7}b",
      "a\u{202E}b",
      "a\u{200B}b",
      "a\u{115F}b",
      "a\u{1160}b",
      "a\u{3164}b",
      "a\u{FFA0}b",
      "a\u{2800}b",
      "a\u{34F}b",
      "a\u{FE00}b",
      "a\u{FE0F}b",
      "a\u{E0000}b",
      "a\u{E0041}b",
      "a\u{E007F}b",
      // Tiga tanda gabung berturut-turut, dari setiap rentang.
      "a\u{301}\u{302}\u{303}",
      "a\u{1AB0}\u{1AB1}\u{1AB2}",
      "a\u{1DC0}\u{1DC1}\u{1DC2}",
      "a\u{20D0}\u{20D1}\u{20D2}",
      "a\u{FE20}\u{FE21}\u{FE22}",
      // Campuran rentang tetap dihitung berturut-turut.
      "a\u{301}\u{1DC0}\u{20D0}",
    ];
    for (const s of rejected) expect(noteHasForbiddenChars(s), JSON.stringify(s)).toBe(true);

    const allowed = [
      "Staf desain, NIK 1042",
      // Dua tanda gabung berturut-turut masih wajar (misalnya huruf Vietnam).
      "Nguye\u{302}\u{303}n",
      "a\u{301}\u{302}b\u{303}\u{304}",
      "Caf\u{E9} \u{1F600}",
      "\u{AC00}\u{B098}\u{B2E4}",
    ];
    for (const s of allowed) expect(noteHasForbiddenChars(s), JSON.stringify(s)).toBe(false);
  });

  it("formulir kantor menyebut data yang dikirim dan siapa yang bisa melihatnya", async () => {
    const u = user();
    commands({ join_search: searchResult({ offices: [office()] }) });
    setup();
    await searchUntilFound(u);
    expect(OFFICE_STEP.sharedWithNote).toBe(
      "Nama Anda, nama laptop, nama akun login laptop ini, alamat IP, dan keterangan tersimpan di catatan kantor dan bisa dilihat admin kantor.",
    );
    const line = screen.getByText(OFFICE_STEP.sharedWithNote);
    const submit = screen.getByRole("button", { name: "Kirim permintaan" });
    expect(submit.getAttribute("aria-describedby")?.split(" ")).toContain(line.id);
  });

  it("formulir kantor v0.3: data yang dikirim tanpa akun login dan keterangan", async () => {
    const u = user();
    commands({ join_search: searchResult({ offices: [office({ acceptsNote: false })] }) });
    setup();
    await searchUntilFound(u);
    expect(OFFICE_STEP.shared).toBe(
      "Nama Anda, nama laptop, dan alamat IP tersimpan di catatan kantor dan bisa dilihat admin kantor.",
    );
    expect(screen.getByText(OFFICE_STEP.shared)).toBeInTheDocument();
    expect(screen.queryByText(OFFICE_STEP.sharedWithNote)).not.toBeInTheDocument();
  });

  it("keterangan berisi spasi saja dikirim sebagai null", async () => {
    const u = user();
    commands({ join_search: searchResult({ offices: [office()] }), join_send_request: outgoing() });
    setup();
    await searchUntilFound(u);
    await u.type(screen.getByLabelText(NOTE), "   ");
    await u.selectOptions(screen.getByLabelText("Departemen"), "Desain");
    await u.click(screen.getByRole("button", { name: "Kirim permintaan" }));
    await waitFor(() => expect(calls("join_send_request")).toHaveLength(1));
    expect(calls("join_send_request")[0][1]).toMatchObject({ note: null });
  });

  it("kantor dengan laptop v0.3 (acceptsNote false atau tidak ada): isian keterangan tidak tampil", async () => {
    const u = user();
    const legacy = office();
    delete (legacy as Partial<typeof legacy>).acceptsNote;
    commands({ join_search: searchResult({ offices: [legacy] }), join_send_request: outgoing() });
    setup();
    await searchUntilFound(u);
    expect(screen.queryByLabelText(NOTE)).not.toBeInTheDocument();
    await u.selectOptions(screen.getByLabelText("Departemen"), "Desain");
    await u.click(screen.getByRole("button", { name: "Kirim permintaan" }));
    await waitFor(() => expect(calls("join_send_request")).toHaveLength(1));
    expect(calls("join_send_request")[0][1]).toMatchObject({ note: null });
  });

  it("pencarian menunggu kantor kedua: putaran pertama satu kantor, putaran kedua dua kantor", async () => {
    const u = user();
    let round = 0;
    commands({
      join_search: () => {
        round += 1;
        return searchResult({
          offices: round === 1 ? [office()] : [office(), office({ key: "lain", name: "Biro Lain", fingerprint: "ZZZZ-9999" })],
        });
      },
    });
    setup();
    await startSearch(u);
    expect(await screen.findByText("Kantor ditemukan, memeriksa kantor lain...")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Mencari kantor di jaringan..." })).toBeInTheDocument();

    await advance(GRACE_MS + 500);
    expect(await screen.findByRole("heading", { name: "Beberapa kantor ditemukan" })).toHaveFocus();
    expect(officeRadios()).toHaveLength(2);
    expect(round).toBeGreaterThanOrEqual(2);
    const settled = round;
    await advance(5_000);
    expect(round).toBe(settled);
  });

  it("beberapa kantor: departemen nonaktif sampai kantor dipilih, daftarnya dari kantor itu", async () => {
    const u = user();
    commands({
      join_search: searchResult({
        offices: [
          office({ key: "a", name: "Biro Utara", departments: [{ id: "t-u", name: "Keuangan" }] }),
          office({ key: "b", name: "Biro Selatan", fingerprint: "ZZZZ-9999", departments: [{ id: "t-s", name: "Gudang" }] }),
        ],
      }),
      join_send_request: outgoing(),
    });
    setup();
    await searchUntilFound(u, "Beberapa kantor ditemukan");

    const dept = screen.getByLabelText("Departemen");
    expect(dept).toBeDisabled();
    expect(screen.getByRole("option", { name: "Pilih kantor dulu" })).toBeInTheDocument();

    await u.click(screen.getByRole("radio", { name: /Biro Selatan/ }));
    expect(dept).toBeEnabled();
    expect(screen.getByRole("option", { name: "Gudang" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Keuangan" })).not.toBeInTheDocument();

    await u.click(screen.getByRole("radio", { name: /Biro Utara/ }));
    expect(screen.getByRole("option", { name: "Keuangan" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Gudang" })).not.toBeInTheDocument();

    await u.selectOptions(dept, "Keuangan");
    await u.click(screen.getByRole("button", { name: "Kirim permintaan" }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("join_send_request", {
        officeKey: "a",
        teamId: "t-u",
        confirmFingerprint: null,
        note: null,
        useAd: false,

      }),
    );
  });

  it("disetujui: onOrganization dipanggil dari polling 5 detik", async () => {
    const u = user();
    let approved = false;
    commands({
      join_search: searchResult({ offices: [office()] }),
      join_send_request: outgoing(),
      join_poll: () => (approved ? { status: "approved", org } : { status: "pending", request: outgoing() }),
    });
    const { onOrganization } = setup();
    await searchUntilFound(u);
    await u.selectOptions(screen.getByLabelText("Departemen"), "Desain");
    await u.click(screen.getByRole("button", { name: "Kirim permintaan" }));
    await screen.findByRole("heading", { name: "Menunggu persetujuan" });

    await advance(5000);
    expect(calls("join_poll")).toHaveLength(1);
    expect(onOrganization).not.toHaveBeenCalled();

    approved = true;
    await advance(5000);
    expect(onOrganization).toHaveBeenCalledWith(org);
  });

  it("ditolak lalu kirim lagi: layar menunggu dengan kode baru", async () => {
    const u = user();
    const rejected = outgoing({ status: "rejected", decidedByName: "Andi", decidedAt: "2026-11-23T12:00:00Z" });
    commands({
      join_outgoing: outgoing(),
      join_poll: { status: "rejected", request: rejected },
      join_resend: outgoing({ requestId: "req-2", code: "9ZZK 0B1T" }),
    });
    setup();
    await screen.findByRole("heading", { name: "Menunggu persetujuan" });

    await advance(5000);
    expect(await screen.findByRole("heading", { name: "Permintaan ditolak" })).toHaveFocus();
    expect(screen.getByText(/Andi menolak/)).toBeInTheDocument();

    invoke.mockImplementation(
      router({
        join_device: device,
        join_resend: outgoing({ requestId: "req-2", code: "9ZZK 0B1T" }),
        join_poll: { status: "pending", request: outgoing({ requestId: "req-2", code: "9ZZK 0B1T" }) },
      }),
    );
    await u.click(screen.getByRole("button", { name: "Kirim permintaan lagi" }));
    expect(await screen.findByRole("heading", { name: "Menunggu persetujuan" })).toBeInTheDocument();
    expect(screen.getByText("9ZZK 0B1T")).toBeInTheDocument();
    expect(screen.queryByText("4F2A 91C0")).not.toBeInTheDocument();
  });

  it("ditolak lalu cari kantor lain: permintaan dibatalkan dan pencarian mulai", async () => {
    const u = user();
    commands({
      join_outgoing: outgoing({ status: "rejected", decidedByName: "Andi" }),
      join_cancel: null,
      join_search: searchResult(),
    });
    setup();
    await u.click(await screen.findByRole("button", { name: "Cari kantor lain" }));
    expect(await screen.findByRole("heading", { name: "Mencari kantor di jaringan..." })).toBeInTheDocument();
    expect(calls("join_cancel")).toHaveLength(1);
  });

  it("batalkan permintaan dari layar menunggu: kembali mencari", async () => {
    const u = user();
    commands({ join_outgoing: outgoing(), join_cancel: null, join_search: searchResult() });
    setup();
    await u.click(await screen.findByRole("button", { name: "Batalkan permintaan" }));
    expect(await screen.findByRole("heading", { name: "Mencari kantor di jaringan..." })).toHaveFocus();
    expect(calls("join_cancel")).toHaveLength(1);
  });

  it("kantor ditemukan setelah permintaan lama dibatalkan tanpa nama: nama ditanyakan dulu", async () => {
    const u = user();
    const saved = { ...fresh().identity, displayName: "Rina" };
    commands({
      join_outgoing: outgoing(),
      join_cancel: null,
      join_search: searchResult({ offices: [office()] }),
      save_display_name: saved,
    });
    setup(fresh(null));
    await u.click(await screen.findByRole("button", { name: "Batalkan permintaan" }));
    await advance(GRACE_MS + 500);
    expect(await screen.findByRole("heading", { name: "Siapa nama Anda?" })).toBeInTheDocument();
    await u.type(screen.getByLabelText("Nama tampilan"), "Rina");
    await u.click(screen.getByRole("button", { name: "Lanjut" }));
    expect(await screen.findByRole("heading", { name: "Kantor ditemukan: Biro Contoh" })).toBeInTheDocument();
    expect(screen.getByText("Rina")).toBeInTheDocument();
  });

  it("kantor kembar dengan identitas bentrok: kirim baru bisa setelah sidik dicocokkan", async () => {
    const u = user();
    commands({
      join_search: searchResult({
        offices: [
          office({ key: "a", fingerprint: "AAAA-1111", conflict: true }),
          office({ key: "b", fingerprint: "BBBB-2222", conflict: true }),
        ],
      }),
      join_send_request: outgoing(),
    });
    setup();
    await searchUntilFound(u, "Beberapa kantor ditemukan");

    expect(screen.getByText("Ada dua kantor dengan nama atau identitas yang sama")).toBeInTheDocument();
    expect(screen.getByText("AAAA-1111")).toBeInTheDocument();
    expect(screen.getByText("BBBB-2222")).toBeInTheDocument();

    await u.click(officeRadios()[0]);
    await u.selectOptions(screen.getByLabelText("Departemen"), "Administrasi");
    expect(screen.getByRole("button", { name: "Kirim permintaan" })).toBeDisabled();
    expect(screen.getByText(/minta ia membacakan sidik organisasi/)).toBeInTheDocument();

    await u.click(screen.getByRole("checkbox", { name: /Sidik dari admin kantor sama dengan AAAA-1111/ }));
    // Pindah kantor membatalkan centang.
    await u.click(officeRadios()[1]);
    expect(screen.getByRole("checkbox", { name: /BBBB-2222/ })).not.toBeChecked();
    await u.click(officeRadios()[0]);
    await u.selectOptions(screen.getByLabelText("Departemen"), "Administrasi");
    await u.click(screen.getByRole("checkbox", { name: /Sidik dari admin kantor sama dengan AAAA-1111/ }));
    await u.click(screen.getByRole("button", { name: "Kirim permintaan" }));
    expect(document.body.textContent).not.toMatch(/superadmin/);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("join_send_request", {
        officeKey: "a",
        teamId: "t-adm",
        confirmFingerprint: "AAAA-1111",
        note: null,
        useAd: false,

      }),
    );
  });

  it("beberapa kantor bernama sama: pilih kantor dulu, lalu kirim ke kantor itu", async () => {
    const u = user();
    commands({
      join_search: searchResult({
        offices: [office({ key: "a", sameName: true }), office({ key: "b", fingerprint: "ZZZZ-9999", sameName: true })],
      }),
      join_send_request: outgoing(),
    });
    setup();
    await searchUntilFound(u, "Beberapa kantor ditemukan");
    expect(screen.getByText("Ada dua kantor dengan nama atau identitas yang sama")).toBeInTheDocument();

    await u.click(screen.getByRole("button", { name: "Kirim permintaan" }));
    expect(await screen.findByText("Pilih kantor Anda dulu.")).toBeInTheDocument();

    await u.click(officeRadios()[1]);
    await u.selectOptions(screen.getByLabelText("Departemen"), "Administrasi");
    await u.click(screen.getByRole("button", { name: "Kirim permintaan" }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("join_send_request", {
        officeKey: "b",
        teamId: "t-adm",
        confirmFingerprint: null,
        note: null,
        useAd: false,

      }),
    );
  });

  it("kantor tanpa departemen: menjelaskan dan tidak bisa mengirim", async () => {
    const u = user();
    commands({ join_search: searchResult({ offices: [office({ departments: [] })] }) });
    setup();
    await searchUntilFound(u);
    expect(screen.getByText("Kantor ini belum punya departemen")).toBeInTheDocument();
    expect(screen.queryByLabelText("Departemen")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Kirim permintaan" })).toBeDisabled();
  });

  it("kirim gagal: pesan dari inti tampil", async () => {
    const u = user();
    commands({
      join_search: searchResult({ offices: [office()] }),
      join_send_request: rustError("busy", "Laptop anggota sedang sibuk. Coba lagi sebentar lagi."),
    });
    setup();
    await searchUntilFound(u);
    await u.selectOptions(screen.getByLabelText("Departemen"), "Desain");
    await u.click(screen.getByRole("button", { name: "Kirim permintaan" }));
    expect(await screen.findByText("Permintaan belum terkirim")).toBeInTheDocument();
    expect(screen.getByText(/sedang sibuk/)).toBeInTheDocument();
  });
});

describe("Onboarding: kantor belum ditemukan", () => {
  it("15 detik tanpa kantor: cara lain, kantor baru tersembunyi di bagian Untuk admin IT", async () => {
    const u = user();
    let inflight = 0;
    let overlap = false;
    commands({
      join_search: async () => {
        inflight += 1;
        if (inflight > 1) overlap = true;
        await new Promise((r) => setTimeout(r, 300));
        inflight -= 1;
        return searchResult();
      },
    });
    setup();
    await startSearch(u);

    expect(screen.getByText("Pencarian berhenti sendiri setelah 15 detik.")).toBeInTheDocument();
    expect(await screen.findByText("LAPTOP-DESAIN-03")).toBeInTheDocument();
    expect(screen.getByText("192.168.1.23")).toBeInTheDocument();

    await advance(14_000);
    expect(screen.getByRole("heading", { name: "Mencari kantor di jaringan..." })).toBeInTheDocument();
    await advance(1_500);

    expect(await screen.findByRole("heading", { name: "Kantor belum ditemukan" })).toHaveFocus();
    expect(screen.getByText(/lewat VPN/)).toBeInTheDocument();
    expect(screen.getByText(/Tidak ada kantor Mira yang terlihat/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/superadmin/);
    expect(screen.getByRole("button", { name: /Pakai kode undangan/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cari lagi" })).toBeInTheDocument();
    expect(screen.queryByText(/Langkah \d dari 3/)).not.toBeInTheDocument();
    expect(overlap).toBe(false);
    expect(calls("join_search").length).toBeGreaterThan(3);

    // Tertutup: tombol kantor baru tidak ada di pohon aksesibilitas.
    expect(screen.queryByRole("button", { name: NEW_OFFICE })).toBeNull();
    expect(screen.queryByText(NEW_OFFICE)).toBeNull();
    // <summary> asli: browser membukanya dengan Enter atau Spasi lewat klik sintetis.
    const summary = screen.getByText("Untuk admin IT");
    expect(summary.tagName).toBe("SUMMARY");
    expect(summary.closest("details")).not.toHaveAttribute("open");

    await u.click(summary);
    expect(summary.closest("details")).toHaveAttribute("open");
    expect(screen.getByText(/disiapkan sekali saja oleh admin IT atau superadmin/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Siapkan Mira untuk kantor baru" })).toBeVisible();

    await u.click(summary);
    expect(screen.queryByRole("button", { name: NEW_OFFICE })).toBeNull();
  });

  it("ada pengumuman organisasi (orgSeen): kantor baru baru terbuka setelah peringatan dan ketik ulang frasa", async () => {
    const u = user();
    commands({ join_search: searchResult({ orgSeen: true }) });
    setup();
    await startSearch(u);
    await advance(16_000);

    expect(await screen.findByRole("heading", { name: "Kantor belum ditemukan" })).toBeInTheDocument();
    await u.click(screen.getByText("Untuk admin IT"));
    const guard = screen.getByTestId("onb-second-office");
    expect(within(guard).getByText("Sudah ada kantor Mira di jaringan ini")).toBeVisible();
    expect(within(guard).getByText(/sudah tergabung ke kantor Mira, walau belum menjawab/)).toBeVisible();
    expect(screen.queryByRole("button", { name: NEW_OFFICE })).toBeNull();
    // Tanpa kantor yang menjawab, tidak ada tombol bergabung.
    expect(within(guard).queryByRole("button", { name: "Minta bergabung ke kantor itu" })).toBeNull();

    const input = screen.getByLabelText('Tetap perlu kantor baru? Ketik "kantor baru" untuk melanjutkan.');
    await u.click(screen.getByRole("button", { name: "Tetap siapkan kantor baru" }));
    expect(await screen.findByText('Ketik "kantor baru" persis, lalu tekan tombolnya lagi.')).toBeInTheDocument();
    expect(input).toHaveFocus();
    expect(input).toHaveAttribute("aria-invalid", "true");

    await u.type(input, "  Kantor   Baru ");
    await u.click(screen.getByRole("button", { name: "Tetap siapkan kantor baru" }));
    expect(await screen.findByRole("heading", { name: "Siapkan Mira untuk kantor baru" })).toHaveFocus();
  });

  it("kantor pernah ditemukan: tombol kantor baru tidak pernah muncul, juga setelah cari lagi", async () => {
    const u = user();
    let found = true;
    commands({ join_search: () => searchResult({ offices: found ? [office()] : [] }) });
    setup();
    await searchUntilFound(u);
    expect(screen.queryByText(NEW_OFFICE)).not.toBeInTheDocument();

    await u.click(screen.getByRole("button", { name: "Cari dengan cara lain" }));
    expect(await screen.findByRole("heading", { name: "Cari kantor dengan cara lain" })).toBeInTheDocument();
    await u.click(screen.getByText("Untuk admin IT"));
    expect(screen.queryByRole("button", { name: NEW_OFFICE })).toBeNull();
    expect(screen.getByText(/Kantor yang terlihat: Biro Contoh\./)).toBeVisible();

    found = false;
    await u.click(screen.getByRole("button", { name: "Cari lagi" }));
    await screen.findByRole("heading", { name: "Mencari kantor di jaringan..." });
    await advance(16_000);
    expect(await screen.findByRole("heading", { name: "Kantor belum ditemukan" })).toBeInTheDocument();
    await u.click(screen.getByText("Untuk admin IT"));
    expect(screen.queryByRole("button", { name: NEW_OFFICE })).toBeNull();
    expect(screen.getByText("Sudah ada kantor Mira di jaringan ini")).toBeVisible();
  });

  it("mDNS mati: langsung ke cara lain dan menyebut sebabnya", async () => {
    const u = user();
    commands({ join_search: searchResult({ mdnsOk: false, mdnsError: "mDNS dimatikan (MIRA_DISABLE_MDNS)." }) });
    setup();
    await passName(u);

    expect(await screen.findByRole("heading", { name: "Kantor belum ditemukan" })).toBeInTheDocument();
    expect(screen.getByText("Pencarian otomatis tidak berjalan di laptop ini")).toBeInTheDocument();
    expect(screen.getByText("mDNS dimatikan (MIRA_DISABLE_MDNS).")).toBeInTheDocument();
  });

  it("Batal saat mencari: cara lain, pencarian berhenti", async () => {
    const u = user();
    commands({ join_search: searchResult() });
    setup();
    await startSearch(u);
    await u.click(screen.getByRole("button", { name: "Batal" }));

    expect(await screen.findByRole("heading", { name: "Cari kantor dengan cara lain" })).toHaveFocus();
    expect(screen.queryByRole("button", { name: NEW_OFFICE })).toBeNull();
    const before = calls("join_search").length;
    await advance(5_000);
    expect(calls("join_search")).toHaveLength(before);
  });

  it("Batal saat masa tunggu: kantor yang sudah menjawab tetap ditampilkan", async () => {
    const u = user();
    commands({ join_search: searchResult({ offices: [office()] }) });
    setup();
    await startSearch(u);
    await screen.findByText("Kantor ditemukan, memeriksa kantor lain...");
    await u.click(screen.getByRole("button", { name: "Batal" }));
    expect(await screen.findByRole("heading", { name: "Kantor ditemukan: Biro Contoh" })).toHaveFocus();
  });

  it("Batal setelah ada pengumuman organisasi: bagian admin IT tidak menawarkan kantor baru", async () => {
    const u = user();
    commands({ join_search: searchResult({ orgSeen: true }) });
    setup();
    await startSearch(u);
    await waitFor(() => expect(calls("join_search").length).toBeGreaterThan(0));
    await advance(100);
    await u.click(screen.getByRole("button", { name: "Batal" }));
    await screen.findByRole("heading", { name: "Cari kantor dengan cara lain" });
    await u.click(screen.getByText("Untuk admin IT"));
    expect(screen.queryByRole("button", { name: NEW_OFFICE })).toBeNull();
    expect(screen.getByText("Sudah ada kantor Mira di jaringan ini")).toBeVisible();
  });

  it("alamat manual: kantor dari alamat itu tampil di layar kantor ditemukan", async () => {
    const u = user();
    commands({
      join_search: searchResult({ mdnsOk: false }),
      join_connect_address: (args) =>
        (args as { address: string }).address === "salah"
          ? (() => {
              throw { code: "invalid_address", message: "Alamat tidak dikenali." };
            })()
          : [office({ name: "Biro Lewat VPN" })],
    });
    setup();
    await passName(u);
    await screen.findByRole("heading", { name: "Kantor belum ditemukan" });

    await u.click(screen.getByRole("button", { name: "Hubungkan" }));
    expect(await screen.findByText(/Isi alamat laptop rekan dulu/)).toBeInTheDocument();

    await u.type(screen.getByLabelText("Masukkan alamat laptop rekan"), "salah");
    await u.click(screen.getByRole("button", { name: "Hubungkan" }));
    expect(await screen.findByText("Alamat tidak dikenali.")).toBeInTheDocument();
    expect(screen.getByLabelText("Masukkan alamat laptop rekan")).toHaveAttribute("aria-invalid", "true");

    await u.clear(screen.getByLabelText("Masukkan alamat laptop rekan"));
    await u.type(screen.getByLabelText("Masukkan alamat laptop rekan"), "10.8.0.5");
    await u.click(screen.getByRole("button", { name: "Hubungkan" }));
    expect(await screen.findByRole("heading", { name: "Kantor ditemukan: Biro Lewat VPN" })).toHaveFocus();
    expect(invoke).toHaveBeenCalledWith("join_connect_address", { address: "10.8.0.5" });
  });

  it("alamat manual tanpa kantor yang menjawab: keterangan di bawah isian", async () => {
    const u = user();
    commands({ join_search: searchResult({ mdnsOk: false }), join_connect_address: [] });
    setup();
    await passName(u);
    await screen.findByRole("heading", { name: "Kantor belum ditemukan" });
    await u.type(screen.getByLabelText("Masukkan alamat laptop rekan"), "192.168.1.20");
    await u.click(screen.getByRole("button", { name: "Hubungkan" }));
    expect(await screen.findByText(/Tidak ada kantor yang menjawab dari alamat itu/)).toBeInTheDocument();
  });
});

describe("Onboarding: kantor baru", () => {
  async function openNewOffice(u: ReturnType<typeof user>) {
    await startSearch(u);
    await advance(16_000);
    await screen.findByRole("heading", { name: "Kantor belum ditemukan" });
    await u.click(screen.getByText("Untuk admin IT"));
    await u.click(screen.getByRole("button", { name: "Siapkan Mira untuk kantor baru" }));
    expect(await screen.findByRole("heading", { name: "Siapkan Mira untuk kantor baru" })).toHaveFocus();
  }

  it("menyimpan nama, membuat organisasi, departemen, lalu memindahkan diri sendiri", async () => {
    const u = user();
    const saved = { ...fresh().identity, displayName: "Andi" };
    commands({
      join_search: searchResult(),
      save_display_name: saved,
      create_organization: org,
      org_create_department: { id: "t-man", name: "Manajemen", createdAt: "", archived: false, archivedAt: null, memberCount: 0 },
      org_move_member: null,
    });
    const { onOrganization } = setup();
    await openNewOffice(u);

    expect(screen.getByText("Hanya untuk orang pertama di kantor")).toBeInTheDocument();
    expect(screen.getByText(/VPN atau Wi-Fi yang terpisah/)).toBeInTheDocument();
    expect(screen.getByText("Untuk memastikan, ketik nama organisasi persis seperti di atas.")).toBeInTheDocument();

    await u.click(screen.getByRole("button", { name: "Buat organisasi" }));
    expect(await screen.findByText("Isi nama organisasi dulu.")).toBeInTheDocument();
    expect(screen.getByLabelText("Nama organisasi")).toHaveFocus();
    expect(screen.getByText("Isi nama departemen dulu.")).toBeInTheDocument();
    expect(calls("create_organization")).toHaveLength(0);

    await u.type(screen.getByLabelText("Nama organisasi"), "Kantor Uji");
    await u.clear(screen.getByLabelText("Nama Anda"));
    await u.type(screen.getByLabelText("Nama Anda"), "Andi");
    await u.type(screen.getByLabelText("Departemen Anda"), "Manajemen");
    await u.type(screen.getByLabelText("Ketik ulang nama organisasi"), " Kantor Uji ");
    await u.click(screen.getByRole("button", { name: "Buat organisasi" }));

    await waitFor(() => expect(onOrganization).toHaveBeenCalledWith(org));
    const order = invoke.mock.calls
      .map(([c]) => c)
      .filter((c) => ["save_display_name", "create_organization", "org_create_department", "org_move_member"].includes(c));
    expect(order).toEqual(["save_display_name", "create_organization", "org_create_department", "org_move_member"]);
    expect(invoke).toHaveBeenCalledWith("create_organization", { name: "Kantor Uji", adDomain: null });
    expect(invoke).toHaveBeenCalledWith("org_create_department", { name: "Manajemen" });
    expect(invoke).toHaveBeenCalledWith("org_move_member", { publicKey: fresh().identity.publicKey, teamId: "t-man" });
  });

  it("ketik ulang nama organisasi tidak sama: ditolak dengan pesan di isiannya", async () => {
    const u = user();
    commands({ join_search: searchResult(), create_organization: org });
    setup();
    await openNewOffice(u);

    await u.type(screen.getByLabelText("Nama organisasi"), "Kantor Uji");
    await u.type(screen.getByLabelText("Departemen Anda"), "Manajemen");
    await u.type(screen.getByLabelText("Ketik ulang nama organisasi"), "Kantor Uij");
    await u.click(screen.getByRole("button", { name: "Buat organisasi" }));

    expect(await screen.findByText(/Belum sama dengan nama organisasi di atas/)).toBeInTheDocument();
    expect(screen.getByLabelText("Ketik ulang nama organisasi")).toHaveFocus();
    expect(screen.getByLabelText("Ketik ulang nama organisasi")).toHaveAttribute("aria-invalid", "true");
    expect(calls("create_organization")).toHaveLength(0);
  });

  it("departemen gagal dibuat: organisasi tetap jadi, lalu Buka Mira", async () => {
    const u = user();
    commands({
      join_search: searchResult(),
      create_organization: org,
      org_create_department: rustError("database", "Data tidak bisa disimpan."),
    });
    const { onOrganization } = setup();
    await openNewOffice(u);

    await u.type(screen.getByLabelText("Nama organisasi"), "Kantor Uji");
    await u.type(screen.getByLabelText("Departemen Anda"), "Manajemen");
    await u.type(screen.getByLabelText("Ketik ulang nama organisasi"), "Kantor Uji");
    await u.click(screen.getByRole("button", { name: "Buat organisasi" }));

    expect(await screen.findByRole("heading", { name: "Organisasi Kantor Uji sudah dibuat" })).toHaveFocus();
    expect(screen.getByText("Departemen Manajemen belum selesai disiapkan")).toBeInTheDocument();
    expect(onOrganization).not.toHaveBeenCalled();
    await u.click(screen.getByRole("button", { name: "Buka Mira" }));
    expect(onOrganization).toHaveBeenCalledWith(org);
    expect(calls("save_display_name")).toHaveLength(0);
  });

  it("Kembali dari kantor baru ke cara lain", async () => {
    const u = user();
    commands({ join_search: searchResult() });
    setup();
    await openNewOffice(u);
    await u.click(screen.getByRole("button", { name: "Kembali" }));
    expect(await screen.findByRole("heading", { name: "Kantor belum ditemukan" })).toBeInTheDocument();
    expect(screen.getByText("Untuk admin IT")).toBeInTheDocument();
  });
});
