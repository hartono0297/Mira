import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState, OrgInfo } from "../../api";
import type { LabelView, PersonView } from "../../api/org";
import { appState, directory, router, rustError } from "../../test/fixtures";
import {
  adminOverview,
  label,
  LABEL_1,
  LABEL_2,
  ME,
  overview,
  person,
  PK_B,
  PK_C,
  PK_D,
  TEAM_2,
} from "../../test/orgFixtures";
import { OrgScreen } from "./OrgScreen";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

const state = appState() as AppState & { organization: OrgInfo };
const GONE = "f".repeat(64);
const LABEL_3 = "6".repeat(32);
const NEW_LABEL = "7".repeat(32);

const PEOPLE: PersonView[] = [
  person(ME, "Andi", { isSuperadmin: true, labels: [{ id: LABEL_2, name: "Arsitek" }] }),
  person(PK_B, "Budi", { departmentId: TEAM_2, departmentName: "Drafting", labels: [{ id: LABEL_1, name: "Drafter" }] }),
  person(PK_C, "Sari", { departmentId: TEAM_2, departmentName: "Drafting", labels: [{ id: LABEL_1, name: "Drafter" }] }),
  person(PK_D, "Tono", { isGuest: true, departmentId: null, departmentName: null, departmentRole: null }),
];

// Drafter juga masih menyimpan orang yang sudah dikeluarkan (GONE): tidak dihitung.
const LABELS: LabelView[] = [label(LABEL_1, "Drafter", [PK_B, PK_C, GONE]), label(LABEL_2, "Arsitek", [ME])];

function table(extra: Record<string, unknown> = {}) {
  return router({
    org_overview: overview(),
    get_directory: directory(),
    org_fingerprint: "ABCD-EFGH",
    org_users: [],
    org_departments: [],
    org_join_requests: [],
    org_labels: LABELS,
    org_people: PEOPLE,
    ...(extra as Record<string, never>),
  });
}

async function openLabels(extra: Record<string, unknown> = {}) {
  invoke.mockImplementation(table(extra));
  const user = userEvent.setup();
  render(<OrgScreen state={state} onRefresh={vi.fn()} />);
  await user.click(await screen.findByRole("button", { name: "Label" }));
  return user;
}

function calls(cmd: string) {
  return invoke.mock.calls.filter(([c]) => c === cmd).map(([, args]) => args);
}

beforeEach(() => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  invoke.mockReset();
});

describe("Label: keadaan", () => {
  it("menampilkan teks memuat selama data label belum datang", async () => {
    await openLabels({ org_labels: () => new Promise(() => {}) });
    expect(screen.getByText("Memuat daftar label...")).toBeInTheDocument();
  });

  it("kosong: menyebut sebabnya dan cara membuat label", async () => {
    await openLabels({ org_labels: [] });
    expect(await screen.findByText(/Belum ada label\. Buat label untuk keahlian atau posisi/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Label baru" })).toBeEnabled();
  });

  it("error menampilkan pesan Rust, Coba lagi memuat ulang", async () => {
    let fail = true;
    const user = await openLabels({
      org_labels: () => {
        if (fail) throw { code: "io", message: "Basis data organisasi terkunci." };
        return LABELS;
      },
    });
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("Daftar label belum terbaca")).toBeInTheDocument();
    expect(within(alert).getByText("Basis data organisasi terkunci.")).toBeInTheDocument();
    fail = false;
    await user.click(within(alert).getByRole("button", { name: "Coba lagi" }));
    expect(await screen.findByText("Drafter")).toBeInTheDocument();
  });

  it("daftar label urut nama dengan jumlah orang yang masih aktif", async () => {
    await openLabels();
    const list = await screen.findByRole("list", { name: "Label aktif" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Arsitek");
    expect(rows[0]).toHaveTextContent("1 orang");
    expect(rows[1]).toHaveTextContent("Drafter");
    expect(rows[1]).toHaveTextContent("2 orang");
    expect(screen.getByText(/Paling banyak 3 label tampil di samping satu nama/)).toBeInTheDocument();
    expect(screen.queryByText(/Dihapus \(/)).not.toBeInTheDocument();
  });

  it("bukan superadmin tidak melihat tab Label", async () => {
    invoke.mockImplementation(table({ org_overview: adminOverview() }));
    render(<OrgScreen state={state} onRefresh={vi.fn()} />);
    expect(await screen.findByRole("button", { name: "Anggota" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Label" })).not.toBeInTheDocument();
    expect(calls("org_labels")).toHaveLength(0);
  });
});

describe("Label: buat, ganti nama, hapus, pulihkan", () => {
  it("membuat label lalu langsung menawarkan pemilih orang", async () => {
    const user = await openLabels({ org_create_label: NEW_LABEL });
    await user.click(await screen.findByRole("button", { name: "Label baru" }));
    const dialog = screen.getByRole("dialog", { name: "Label baru" });
    await user.type(within(dialog).getByLabelText("Nama label"), "  K3 ");
    await user.click(within(dialog).getByRole("button", { name: "Buat label" }));

    expect(invoke).toHaveBeenCalledWith("org_create_label", { name: "K3" });
    expect(await screen.findByText("Label K3 dibuat.")).toBeInTheDocument();
    const picker = await screen.findByRole("dialog", { name: "Atur orang untuk label K3" });
    expect(within(picker).getByLabelText("Cari nama")).toHaveFocus();
    await user.click(within(picker).getByRole("checkbox", { name: /^Budi/ }));
    await user.click(within(picker).getByRole("button", { name: "Simpan" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(calls("org_set_label_assigned")).toEqual([{ labelId: NEW_LABEL, publicKey: PK_B, assigned: true }]);
    expect(screen.getByText("Label K3 dipasang ke 1 orang.")).toBeInTheDocument();
  });

  it("menolak nama kosong dan nama lebih dari 30 karakter di tampilan", async () => {
    const user = await openLabels();
    await user.click(await screen.findByRole("button", { name: "Label baru" }));
    const dialog = screen.getByRole("dialog", { name: "Label baru" });
    const input = within(dialog).getByLabelText("Nama label");

    await user.type(input, "   ");
    await user.click(within(dialog).getByRole("button", { name: "Buat label" }));
    expect(within(dialog).getByText("Isi nama label dulu.")).toBeInTheDocument();
    expect(input).toHaveAttribute("aria-invalid", "true");

    await user.clear(input);
    await user.type(input, "a".repeat(31));
    await user.click(within(dialog).getByRole("button", { name: "Buat label" }));
    expect(within(dialog).getByText(/paling banyak 30 karakter/)).toBeInTheDocument();

    await user.clear(input);
    await user.type(input, "drafter");
    await user.click(within(dialog).getByRole("button", { name: "Buat label" }));
    expect(within(dialog).getByText("Label Drafter sudah ada.")).toBeInTheDocument();

    expect(calls("org_create_label")).toHaveLength(0);
  });

  it("error Rust saat membuat label tampil di dialog", async () => {
    const user = await openLabels({ org_create_label: rustError("forbidden", "Hanya superadmin yang boleh membuat label.") });
    await user.click(await screen.findByRole("button", { name: "Label baru" }));
    const dialog = screen.getByRole("dialog", { name: "Label baru" });
    await user.type(within(dialog).getByLabelText("Nama label"), "K3");
    await user.click(within(dialog).getByRole("button", { name: "Buat label" }));
    expect(await within(dialog).findByText("Hanya superadmin yang boleh membuat label.")).toBeInTheDocument();
    expect(within(dialog).getByText("Label belum dibuat")).toBeInTheDocument();
  });

  it("mengganti nama label", async () => {
    const user = await openLabels();
    await user.click(await screen.findByRole("button", { name: "Ganti nama, label Drafter" }));
    const dialog = screen.getByRole("dialog", { name: "Ganti nama label Drafter" });
    const input = within(dialog).getByLabelText("Nama label");
    expect(input).toHaveValue("Drafter");
    await user.clear(input);
    await user.type(input, "Juru gambar");
    await user.click(within(dialog).getByRole("button", { name: "Simpan nama" }));

    expect(invoke).toHaveBeenCalledWith("org_rename_label", { labelId: LABEL_1, name: "Juru gambar" });
    expect(await screen.findByText("Label Drafter sekarang bernama Juru gambar.")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("Escape membatalkan ganti nama tanpa memanggil Rust", async () => {
    const user = await openLabels();
    const opener = await screen.findByRole("button", { name: "Ganti nama, label Drafter" });
    await user.click(opener);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(calls("org_rename_label")).toHaveLength(0);
    expect(opener).toHaveFocus();
  });

  it("hapus meminta konfirmasi, lalu mengarsipkan label", async () => {
    const user = await openLabels();
    await user.click(await screen.findByRole("button", { name: "Hapus label Drafter" }));
    const dialog = screen.getByRole("dialog", { name: "Hapus label Drafter?" });
    expect(dialog).toHaveTextContent("hilang dari samping nama 2 orang");
    expect(dialog).toHaveTextContent(/dipulihkan dari bagian Dihapus, label kembali ke orang yang sama/);
    expect(within(dialog).getByRole("button", { name: "Batal" })).toHaveFocus();
    expect(calls("org_set_label_archived")).toHaveLength(0);

    await user.click(within(dialog).getByRole("button", { name: "Hapus Drafter" }));
    expect(invoke).toHaveBeenCalledWith("org_set_label_archived", { labelId: LABEL_1, archived: true });
    expect(await screen.findByText(/Label Drafter dihapus\./)).toBeInTheDocument();
  });

  it("gagal menghapus: pesan Rust tampil di dialog konfirmasi", async () => {
    const user = await openLabels({ org_set_label_archived: rustError("label_not_found", "Label tidak ditemukan.") });
    await user.click(await screen.findByRole("button", { name: "Hapus label Drafter" }));
    const dialog = screen.getByRole("dialog", { name: "Hapus label Drafter?" });
    await user.click(within(dialog).getByRole("button", { name: "Hapus Drafter" }));
    expect(await within(dialog).findByText("Label tidak ditemukan.")).toBeInTheDocument();
  });

  it("label yang dihapus ada di bagian lipat dan bisa dipulihkan", async () => {
    const user = await openLabels({
      org_labels: [...LABELS, label(LABEL_3, "Lama", [PK_B], { archived: true })],
    });
    const summary = await screen.findByText("Dihapus (1)");
    const restore = screen.getByRole("button", { name: "Pulihkan label Lama", hidden: true });
    expect(restore).not.toBeVisible();
    await user.click(summary);
    expect(restore).toBeVisible();
    expect(screen.getByText("1 orang tersimpan")).toBeInTheDocument();
    await user.click(restore);
    expect(invoke).toHaveBeenCalledWith("org_set_label_archived", { labelId: LABEL_3, archived: false });
    expect(await screen.findByText(/Label Lama dipulihkan/)).toBeInTheDocument();
  });

  it("semua label dihapus: keadaan kosong mengarah ke bagian Dihapus", async () => {
    await openLabels({ org_labels: [label(LABEL_3, "Lama", [], { archived: true })] });
    expect(await screen.findByText(/Semua label sudah dihapus/)).toBeInTheDocument();
  });
});

describe("Label: atur orang", () => {
  async function openPicker(extra: Record<string, unknown> = {}) {
    const user = await openLabels(extra);
    await user.click(await screen.findByRole("button", { name: "Atur orang, label Drafter" }));
    const dialog = screen.getByRole("dialog", { name: "Atur orang untuk label Drafter" });
    return { user, dialog };
  }

  it("centang dan lepas menghasilkan panggilan yang benar", async () => {
    const { user, dialog } = await openPicker();
    const budi = within(dialog).getByRole("checkbox", { name: /^Budi/ });
    const sari = within(dialog).getByRole("checkbox", { name: /^Sari/ });
    // jsdom membuang spasi di awal span, jadi nama tercatat "Andi(Anda), labelArsitek".
    const andi = within(dialog).getByRole("checkbox", { name: /^Andi.*\(Anda\).*label.*Arsitek/ });
    expect(budi).toBeChecked();
    expect(sari).toBeChecked();
    expect(andi).not.toBeChecked();
    expect(within(dialog).getByText("Tamu", { selector: ".ppick-sub" })).toBeInTheDocument();
    expect(within(dialog).getAllByText("Drafting", { selector: ".ppick-sub" })).toHaveLength(2);

    await user.click(sari);
    await user.click(andi);
    expect(within(dialog).getByText(/2 perubahan belum disimpan/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Simpan" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(calls("org_set_label_assigned")).toEqual([
      { labelId: LABEL_1, publicKey: ME, assigned: true },
      { labelId: LABEL_1, publicKey: PK_C, assigned: false },
    ]);
    expect(screen.getByText("Label Drafter dipasang ke 1 orang dan dilepas dari 1 orang.")).toBeInTheDocument();
  });

  it("Simpan tanpa perubahan hanya menutup dialog", async () => {
    const { user, dialog } = await openPicker();
    await user.click(within(dialog).getByRole("button", { name: "Simpan" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(calls("org_set_label_assigned")).toHaveLength(0);
  });

  it("pencarian nama dan saringan departemen, lalu melonggarkannya", async () => {
    const { user, dialog } = await openPicker();
    expect(within(dialog).getAllByRole("checkbox")).toHaveLength(4);

    await user.type(within(dialog).getByLabelText("Cari nama"), "sa");
    expect(within(dialog).getAllByRole("checkbox")).toHaveLength(1);
    expect(within(dialog).getByRole("checkbox", { name: /^Sari/ })).toBeInTheDocument();

    await user.clear(within(dialog).getByLabelText("Cari nama"));
    const select = within(dialog).getByLabelText("Departemen");
    expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Semua departemen",
      "Desain",
      "Drafting",
      "Tamu",
    ]);
    await user.selectOptions(select, "Tamu");
    expect(within(dialog).getAllByRole("checkbox")).toHaveLength(1);
    expect(within(dialog).getByRole("checkbox", { name: /^Tono/ })).toBeInTheDocument();

    await user.type(within(dialog).getByLabelText("Cari nama"), "budi");
    expect(within(dialog).queryAllByRole("checkbox")).toHaveLength(0);
    expect(within(dialog).getByText('Tidak ada orang yang cocok dengan nama "budi" dan saringan Tamu.')).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Tampilkan semua orang" }));
    expect(within(dialog).getAllByRole("checkbox")).toHaveLength(4);
  });

  it("saringan Belum ada departemen muncul kalau ada orangnya", async () => {
    const { user, dialog } = await openPicker({
      org_people: [...PEOPLE, person("9".repeat(64), "Wati", { departmentId: null, departmentName: null })],
    });
    await user.selectOptions(within(dialog).getByLabelText("Departemen"), "Belum ada departemen");
    expect(within(dialog).getAllByRole("checkbox")).toHaveLength(1);
    expect(within(dialog).getByRole("checkbox", { name: /^Wati/ })).toBeInTheDocument();
  });

  it("gagal di tengah: berhenti, menyebut yang sudah tersimpan, dialog tetap terbuka", async () => {
    const { user, dialog } = await openPicker({
      org_set_label_assigned: (args: Record<string, unknown> | undefined) => {
        if (args?.publicKey === PK_C) throw { code: "target_not_active", message: "Sari sudah tidak aktif." };
        return null;
      },
    });
    await user.click(within(dialog).getByRole("checkbox", { name: /^Andi/ }));
    await user.click(within(dialog).getByRole("checkbox", { name: /^Tono/ }));
    await user.click(within(dialog).getByRole("checkbox", { name: /^Sari/ }));
    await user.click(within(dialog).getByRole("button", { name: "Simpan" }));

    expect(await within(dialog).findByText("Berhenti saat melepas label dari Sari")).toBeInTheDocument();
    expect(within(dialog).getByText("Sari sudah tidak aktif.")).toBeInTheDocument();
    expect(within(dialog).getByText(/2 dari 3 perubahan sudah tersimpan\./)).toBeInTheDocument();
    expect(calls("org_set_label_assigned")).toHaveLength(3);

    // Simpan lagi hanya mengirim sisa yang belum tersimpan.
    await user.click(within(dialog).getByRole("button", { name: "Simpan" }));
    await waitFor(() => expect(calls("org_set_label_assigned")).toHaveLength(4));
    expect(calls("org_set_label_assigned")[3]).toEqual({ labelId: LABEL_1, publicKey: PK_C, assigned: false });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("catatan untuk orang yang sudah punya 3 label lain", async () => {
    const many = [
      { id: LABEL_2, name: "Arsitek" },
      { id: LABEL_3, name: "K3" },
      { id: "8".repeat(32), name: "Senior" },
    ];
    const { dialog } = await openPicker({
      org_people: [person(PK_B, "Budi", { labels: [...many, { id: LABEL_1, name: "Drafter" }] }), person(PK_C, "Sari")],
    });
    const budi = within(dialog).getByRole("checkbox", { name: /^Budi/ });
    expect(budi).toHaveAccessibleDescription(/Sudah punya 3 label lain\. Di samping nama hanya tampil 3 label pertama/);
    expect(within(dialog).getByRole("checkbox", { name: /^Sari/ })).not.toHaveAccessibleDescription(/Sudah punya/);
  });

  it("Escape menutup pemilih orang tanpa menyimpan", async () => {
    const { user, dialog } = await openPicker();
    await user.click(within(dialog).getByRole("checkbox", { name: /^Andi/ }));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(calls("org_set_label_assigned")).toHaveLength(0);
  });
});

describe("Label: menu klik kanan", () => {
  function rowOf(name: string) {
    const row = screen.getByText(name, { selector: ".lbl-lab" }).closest<HTMLElement>("li");
    if (!row) throw new Error(`Baris ${name} tidak ada`);
    return row;
  }

  function menuIds() {
    return within(screen.getByRole("menu"))
      .getAllByRole("menuitem")
      .map((el) => el.getAttribute("data-menu-item"));
  }

  it("klik kanan label aktif: Atur orang, Ganti nama, Hapus (merah)", async () => {
    const user = await openLabels();
    await screen.findByRole("list", { name: "Label aktif" });
    await user.pointer({ keys: "[MouseRight]", target: screen.getByText("Drafter", { selector: ".lbl-lab" }) });
    const menu = screen.getByRole("menu", { name: "Aksi untuk label Drafter" });
    expect(menuIds()).toEqual(["assign", "rename", "delete"]);
    expect(within(menu).getByRole("menuitem", { name: "Atur orang" })).toHaveFocus();
    expect(within(menu).getByRole("menuitem", { name: "Hapus" })).toHaveClass("cmenu-danger");
  });

  it("Atur orang lewat menu membuka pemilih; Escape mengembalikan fokus ke baris", async () => {
    const user = await openLabels();
    await screen.findByRole("list", { name: "Label aktif" });
    await user.pointer({ keys: "[MouseRight]", target: rowOf("Drafter") });
    await user.click(screen.getByRole("menuitem", { name: "Atur orang" }));
    expect(screen.getByRole("dialog", { name: "Atur orang untuk label Drafter" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Atur orang, label Drafter" })).toHaveFocus();
  });

  it("Ganti nama lewat menu membuka dialog yang sama", async () => {
    const user = await openLabels();
    await screen.findByRole("list", { name: "Label aktif" });
    await user.pointer({ keys: "[MouseRight]", target: rowOf("Arsitek") });
    await user.click(screen.getByRole("menuitem", { name: "Ganti nama" }));
    const dialog = screen.getByRole("dialog", { name: "Ganti nama label Arsitek" });
    expect(within(dialog).getByLabelText("Nama label")).toHaveValue("Arsitek");
  });

  it("Shift+F10 dari baris terfokus, Hapus meminta konfirmasi lalu mengarsipkan", async () => {
    const user = await openLabels();
    const rename = await screen.findByRole("button", { name: "Ganti nama, label Drafter" });
    rename.focus();
    await user.keyboard("{Shift>}{F10}{/Shift}");
    expect(screen.getByRole("menu", { name: "Aksi untuk label Drafter" })).toBeInTheDocument();
    await user.keyboard("{End}{Enter}");
    const dialog = screen.getByRole("dialog", { name: "Hapus label Drafter?" });
    expect(calls("org_set_label_archived")).toHaveLength(0);
    await user.click(within(dialog).getByRole("button", { name: "Hapus Drafter" }));
    expect(invoke).toHaveBeenCalledWith("org_set_label_archived", { labelId: LABEL_1, archived: true });
  });

  it("label yang dihapus: Pulihkan lewat menu, lalu fokus pindah ke Atur orang", async () => {
    let labels = [...LABELS, label(LABEL_3, "Lama", [PK_B], { archived: true })];
    const user = await openLabels({
      org_labels: () => labels,
      org_set_label_archived: (args: { labelId: string; archived: boolean }) => {
        labels = labels.map((l) => (l.id === args.labelId ? { ...l, archived: args.archived } : l));
        return null;
      },
    });
    await user.click(await screen.findByText("Dihapus (1)"));
    await user.pointer({ keys: "[MouseRight]", target: rowOf("Lama") });
    const menu = screen.getByRole("menu", { name: "Aksi untuk label Lama" });
    expect(menuIds()).toEqual(["restore"]);
    await user.click(within(menu).getByRole("menuitem", { name: "Pulihkan" }));
    expect(invoke).toHaveBeenCalledWith("org_set_label_archived", { labelId: LABEL_3, archived: false });
    await waitFor(() => expect(screen.getByRole("button", { name: "Atur orang, label Lama" })).toHaveFocus());
  });

  it("selama aksi lain berjalan, item menu nonaktif dengan alasan", async () => {
    const user = await openLabels({
      org_labels: [...LABELS, label(LABEL_3, "Lama", [PK_B], { archived: true })],
      org_set_label_archived: () => new Promise(() => {}),
    });
    await user.click(await screen.findByText("Dihapus (1)"));
    await user.click(screen.getByRole("button", { name: "Pulihkan label Lama" }));
    await user.pointer({ keys: "[MouseRight]", target: rowOf("Drafter") });
    const items = within(screen.getByRole("menu")).getAllByRole("menuitem");
    for (const item of items) {
      expect(item).toHaveAttribute("aria-disabled", "true");
      expect(item).toHaveAccessibleDescription("Tunggu perubahan yang sedang disimpan.");
    }
    await user.keyboard("{Enter}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
