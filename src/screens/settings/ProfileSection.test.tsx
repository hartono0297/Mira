import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppError, AppState, OrgInfo } from "../../api";
import type { PersonView } from "../../api/org";
import { setLang } from "../../i18n/core";
import { appState, ME, org, PK_B, PK_C, PK_D } from "../../test/fixtures";
import { renderInLang } from "../../test/i18n";
import { ProfileSection } from "./ProfileSection";

const api = vi.hoisted(() => ({
  profileMyPhoto: vi.fn(),
  profileClearPhoto: vi.fn(),
  profilePhotos: vi.fn(),
  profileAdminRemovePhoto: vi.fn(),
  people: vi.fn(),
  refreshProfilePhotos: vi.fn(),
  start: vi.fn(),
  changeError: { value: null as AppError | null },
  changeBusy: { value: false },
}));

vi.mock("../../api/profile", () => ({
  PROFILE_TOPIC: "profile",
  profileMyPhoto: api.profileMyPhoto,
  profileClearPhoto: api.profileClearPhoto,
  profilePhotos: api.profilePhotos,
  profileAdminRemovePhoto: api.profileAdminRemovePhoto,
}));
vi.mock("../../api/org", () => ({
  orgApi: { people: api.people },
  subscribeOrg: () => () => {},
}));
vi.mock("../../components/profilePhotos", () => ({
  refreshProfilePhotos: api.refreshProfilePhotos,
  usePhotoUrl: () => null,
}));
vi.mock("../../components/profile/useChangePhoto", () => ({
  useChangePhoto: () => ({ start: api.start, busy: api.changeBusy.value, error: api.changeError.value, element: null }),
}));
vi.mock("../../components/Avatar", () => ({
  Avatar: ({ name, publicKey }: { name: string; publicKey?: string | null }) => (
    <span className="avatar" data-avatar-key={publicKey ?? undefined} aria-hidden="true">
      {name.slice(0, 1)}
    </span>
  ),
}));

// Radix mengembalikan fokus dialog dengan setTimeout; tunggu itu lewat supaya
// tes memeriksa fokus akhir, bukan sesaat.
function settle() {
  return act(() => new Promise<void>((resolve) => setTimeout(resolve, 30)));
}

function person(publicKey: string, displayName: string): PersonView {
  return {
    publicKey,
    displayName,
    fingerprint: "0000",
    role: "member",
    isSuperadmin: false,
    isGuest: false,
    departmentId: null,
    departmentName: null,
    departmentRole: null,
    labels: [],
  };
}

function stateAs(role: OrgInfo["role"]) {
  return appState({ organization: { ...org, role } }) as AppState & { organization: OrgInfo };
}

function renderSection(role: OrgInfo["role"] = "member") {
  return render(<ProfileSection state={stateAs(role)} />);
}

afterEach(() => setLang("id"));

beforeEach(() => {
  vi.clearAllMocks();
  api.changeError.value = null;
  api.changeBusy.value = false;
  api.profileMyPhoto.mockResolvedValue({ hash: null, removedByAdmin: false });
  api.profileClearPhoto.mockResolvedValue(undefined);
  api.profileAdminRemovePhoto.mockResolvedValue(undefined);
  api.refreshProfilePhotos.mockResolvedValue(undefined);
  api.profilePhotos.mockResolvedValue([]);
  api.people.mockResolvedValue([]);
});

describe("Pengaturan > Profil", () => {
  it("tanpa foto: hanya tombol Ganti foto", async () => {
    renderSection();
    expect(screen.getByRole("heading", { name: "Profil", level: 2 })).toBeInTheDocument();
    expect(await screen.findByText("Belum ada foto. Rekan melihat inisial nama Anda.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ganti foto" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Hapus foto" })).not.toBeInTheDocument();
  });

  it("dengan foto: tombol Ganti foto dan Hapus foto", async () => {
    api.profileMyPhoto.mockResolvedValue({ hash: "f".repeat(64), removedByAdmin: false });
    renderSection();
    expect(await screen.findByRole("button", { name: "Hapus foto" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ganti foto" })).toBeInTheDocument();
    expect(screen.queryByText(/Belum ada foto/)).not.toBeInTheDocument();
  });

  it("Ganti foto memulai pemilihan foto", async () => {
    const user = userEvent.setup();
    renderSection();
    await user.click(screen.getByRole("button", { name: "Ganti foto" }));
    expect(api.start).toHaveBeenCalledTimes(1);
  });

  it("error pilih foto tampil sebagai kotak error", async () => {
    api.changeError.value = { code: "invalid_name", message: "Foto terlalu besar. Pilih file sampai 20 MB." };
    renderSection();
    expect(await screen.findByText("Foto belum bisa dipakai")).toBeInTheDocument();
    expect(screen.getByText("Foto terlalu besar. Pilih file sampai 20 MB.")).toBeInTheDocument();
  });

  it("Hapus foto minta konfirmasi lalu memanggil profileClearPhoto", async () => {
    const user = userEvent.setup();
    api.profileMyPhoto.mockResolvedValueOnce({ hash: "f".repeat(64), removedByAdmin: false });
    renderSection();
    await user.click(await screen.findByRole("button", { name: "Hapus foto" }));
    const dialog = await screen.findByRole("dialog", { name: "Hapus foto profil?" });
    expect(api.profileClearPhoto).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Hapus foto" }));
    await waitFor(() => expect(api.profileClearPhoto).toHaveBeenCalledTimes(1));
    expect(api.refreshProfilePhotos).toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(await screen.findByText("Foto profil dihapus.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Hapus foto" })).not.toBeInTheDocument();
  });

  it("setelah foto dihapus fokus pindah ke Ganti foto", async () => {
    const user = userEvent.setup();
    api.profileMyPhoto.mockResolvedValueOnce({ hash: "f".repeat(64), removedByAdmin: false });
    renderSection();
    await user.click(await screen.findByRole("button", { name: "Hapus foto" }));
    const dialog = await screen.findByRole("dialog", { name: "Hapus foto profil?" });
    await user.click(within(dialog).getByRole("button", { name: "Hapus foto" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Hapus foto" })).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole("button", { name: "Ganti foto" })).toHaveFocus());
    await settle();
    expect(screen.getByRole("button", { name: "Ganti foto" })).toHaveFocus();
  });

  it("sedang memilih foto: Ganti foto tetap bisa difokus, aria-disabled, dan tidak memulai lagi", async () => {
    const user = userEvent.setup();
    api.changeBusy.value = true;
    renderSection();
    const button = screen.getByRole("button", { name: "Ganti foto" });
    expect(button).not.toBeDisabled();
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).toHaveAttribute("aria-busy", "true");
    button.focus();
    await user.keyboard("{Enter}");
    expect(button).toHaveFocus();
    expect(api.start).not.toHaveBeenCalled();
  });

  it("Batal di konfirmasi tidak menghapus", async () => {
    const user = userEvent.setup();
    api.profileMyPhoto.mockResolvedValue({ hash: "f".repeat(64), removedByAdmin: false });
    renderSection();
    await user.click(await screen.findByRole("button", { name: "Hapus foto" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Batal" }));
    expect(api.profileClearPhoto).not.toHaveBeenCalled();
  });

  it("gagal hapus: error tampil di dialog", async () => {
    const user = userEvent.setup();
    api.profileMyPhoto.mockResolvedValue({ hash: "f".repeat(64), removedByAdmin: false });
    api.profileClearPhoto.mockRejectedValue({ code: "not_found", message: "Foto tidak ditemukan." });
    renderSection();
    await user.click(await screen.findByRole("button", { name: "Hapus foto" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Hapus foto" }));
    expect(await within(dialog).findByText("Foto tidak ditemukan.")).toBeInTheDocument();
    expect(within(dialog).getByText("Foto belum terhapus")).toBeInTheDocument();
  });

  it("foto dihapus superadmin: catatan tampil", async () => {
    api.profileMyPhoto.mockResolvedValue({ hash: null, removedByAdmin: true });
    renderSection();
    const note = await screen.findByRole("note");
    expect(within(note).getByText("Foto Anda dihapus superadmin")).toBeInTheDocument();
    expect(within(note).getByText(/Anda bisa memasang foto lain/)).toBeInTheDocument();
    expect(screen.queryByText(/Belum ada foto/)).not.toBeInTheDocument();
  });

  it("tanpa catatan kalau foto tidak dihapus superadmin", async () => {
    renderSection();
    await screen.findByText(/Belum ada foto/);
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
  });

  it("gagal membaca foto: error dan tombol coba lagi", async () => {
    const user = userEvent.setup();
    api.profileMyPhoto.mockRejectedValueOnce({ code: "database", message: "Basis data terkunci." });
    renderSection();
    expect(await screen.findByText("Foto profil belum terbaca")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Coba baca lagi" }));
    expect(await screen.findByText(/Belum ada foto/)).toBeInTheDocument();
    expect(screen.queryByText("Foto profil belum terbaca")).not.toBeInTheDocument();
  });
});

describe("Foto anggota", () => {
  it("tidak tampil untuk bukan superadmin", async () => {
    renderSection("team_admin");
    await screen.findByText(/Belum ada foto/);
    expect(screen.queryByRole("heading", { name: "Foto anggota" })).not.toBeInTheDocument();
    expect(api.people).not.toHaveBeenCalled();
    expect(api.profilePhotos).not.toHaveBeenCalled();
  });

  it("superadmin: daftar orang lain yang punya foto, tanpa diri sendiri", async () => {
    api.people.mockResolvedValue([person(ME, "Penguji"), person(PK_B, "Budi"), person(PK_C, "Ayu"), person(PK_D, "Tanpa Foto")]);
    api.profilePhotos.mockResolvedValue([
      { owner: ME, hash: "1".repeat(64) },
      { owner: PK_B, hash: "2".repeat(64) },
      { owner: PK_C, hash: "3".repeat(64) },
    ]);
    renderSection("superadmin");
    const list = await screen.findByRole("list");
    const items = within(list).getAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual(["AAyuHapus foto", "BBudiHapus foto"]);
    expect(screen.getByRole("heading", { name: "Foto anggota", level: 3 })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hapus foto Ayu" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Hapus foto Penguji" })).not.toBeInTheDocument();
    expect(screen.queryByText("Tanpa Foto")).not.toBeInTheDocument();
  });

  it("superadmin: kosong kalau belum ada anggota lain yang berfoto", async () => {
    api.people.mockResolvedValue([person(ME, "Penguji"), person(PK_B, "Budi")]);
    renderSection("superadmin");
    expect(await screen.findByText("Belum ada anggota lain yang memasang foto.")).toBeInTheDocument();
  });

  it("hapus foto anggota memanggil profileAdminRemovePhoto setelah konfirmasi", async () => {
    const user = userEvent.setup();
    api.people.mockResolvedValue([person(PK_B, "Budi")]);
    api.profilePhotos.mockResolvedValueOnce([{ owner: PK_B, hash: "2".repeat(64) }]).mockResolvedValue([]);
    renderSection("superadmin");
    await user.click(await screen.findByRole("button", { name: "Hapus foto Budi" }));
    const dialog = await screen.findByRole("dialog", { name: "Hapus foto Budi?" });
    expect(api.profileAdminRemovePhoto).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Hapus foto" }));
    await waitFor(() => expect(api.profileAdminRemovePhoto).toHaveBeenCalledWith(PK_B));
    expect(api.refreshProfilePhotos).toHaveBeenCalled();
    expect(await screen.findByText("Foto Budi dihapus.")).toBeInTheDocument();
    expect(await screen.findByText("Belum ada anggota lain yang memasang foto.")).toBeInTheDocument();
  });

  it("setelah hapus foto anggota fokus pindah ke baris berikutnya", async () => {
    const user = userEvent.setup();
    api.people.mockResolvedValue([person(PK_B, "Budi"), person(PK_C, "Ayu"), person(PK_D, "Citra")]);
    api.profilePhotos
      .mockResolvedValueOnce([
        { owner: PK_B, hash: "2".repeat(64) },
        { owner: PK_C, hash: "3".repeat(64) },
        { owner: PK_D, hash: "4".repeat(64) },
      ])
      .mockResolvedValue([
        { owner: PK_C, hash: "3".repeat(64) },
        { owner: PK_D, hash: "4".repeat(64) },
      ]);
    renderSection("superadmin");
    // Urutan: Ayu, Budi, Citra. Budi dihapus, fokus ke Citra.
    await user.click(await screen.findByRole("button", { name: "Hapus foto Budi" }));
    const dialog = await screen.findByRole("dialog", { name: "Hapus foto Budi?" });
    await user.click(within(dialog).getByRole("button", { name: "Hapus foto" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Hapus foto Budi" })).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole("button", { name: "Hapus foto Citra" })).toHaveFocus());
    await settle();
    expect(screen.getByRole("button", { name: "Hapus foto Citra" })).toHaveFocus();
  });

  it("hapus baris terakhir: fokus ke baris sebelumnya", async () => {
    const user = userEvent.setup();
    api.people.mockResolvedValue([person(PK_B, "Budi"), person(PK_C, "Ayu")]);
    api.profilePhotos
      .mockResolvedValueOnce([
        { owner: PK_B, hash: "2".repeat(64) },
        { owner: PK_C, hash: "3".repeat(64) },
      ])
      .mockResolvedValue([{ owner: PK_C, hash: "3".repeat(64) }]);
    renderSection("superadmin");
    await user.click(await screen.findByRole("button", { name: "Hapus foto Budi" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Hapus foto" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Hapus foto Ayu" })).toHaveFocus());
  });

  it("daftar jadi kosong: fokus ke judul Foto anggota", async () => {
    const user = userEvent.setup();
    api.people.mockResolvedValue([person(PK_B, "Budi")]);
    api.profilePhotos.mockResolvedValueOnce([{ owner: PK_B, hash: "2".repeat(64) }]).mockResolvedValue([]);
    renderSection("superadmin");
    await user.click(await screen.findByRole("button", { name: "Hapus foto Budi" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Hapus foto" }));
    const heading = screen.getByRole("heading", { name: "Foto anggota" });
    expect(heading).toHaveAttribute("tabindex", "-1");
    await waitFor(() => expect(heading).toHaveFocus());
    await settle();
    expect(heading).toHaveFocus();
  });

  it("judul konfirmasi tetap berisi nama saat dialog ditutup", async () => {
    const user = userEvent.setup();
    api.people.mockResolvedValue([person(PK_B, "Budi")]);
    api.profilePhotos.mockResolvedValue([{ owner: PK_B, hash: "2".repeat(64) }]);
    renderSection("superadmin");
    await user.click(await screen.findByRole("button", { name: "Hapus foto Budi" }));
    const dialog = await screen.findByRole("dialog", { name: "Hapus foto Budi?" });
    const title = within(dialog).getByText("Hapus foto Budi?");
    await user.click(within(dialog).getByRole("button", { name: "Batal" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    // Isi dialog yang sedang menghilang tidak pernah berganti jadi kosong.
    expect(title.textContent).toBe("Hapus foto Budi?");
    expect(screen.getByRole("button", { name: "Hapus foto Budi" })).toHaveFocus();
  });

  it("batal konfirmasi tidak menghapus foto anggota", async () => {
    const user = userEvent.setup();
    api.people.mockResolvedValue([person(PK_B, "Budi")]);
    api.profilePhotos.mockResolvedValue([{ owner: PK_B, hash: "2".repeat(64) }]);
    renderSection("superadmin");
    await user.click(await screen.findByRole("button", { name: "Hapus foto Budi" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Batal" }));
    expect(api.profileAdminRemovePhoto).not.toHaveBeenCalled();
  });

  it("gagal membaca daftar: error tampil", async () => {
    api.people.mockRejectedValue({ code: "database", message: "Basis data terkunci." });
    renderSection("superadmin");
    expect(await screen.findByText("Foto anggota belum terbaca")).toBeInTheDocument();
  });
});

describe("Profil dalam bahasa Inggris", () => {
  it("judul, tombol, dan daftar berbahasa Inggris", async () => {
    api.profileMyPhoto.mockResolvedValue({ hash: "f".repeat(64), removedByAdmin: false });
    api.people.mockResolvedValue([person(PK_B, "Budi")]);
    api.profilePhotos.mockResolvedValue([{ owner: PK_B, hash: "2".repeat(64) }]);
    renderInLang(() => <ProfileSection state={stateAs("superadmin")} />);
    expect(screen.getByRole("heading", { name: "Profile" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Remove photo" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Change photo" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Member photos" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Remove Budi's photo" })).toBeInTheDocument();
  });
});
