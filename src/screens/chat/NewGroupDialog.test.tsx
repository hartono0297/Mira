import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NewGroupDialog } from "./NewGroupDialog";
import { budi, dimas, group, orgPeople, PK_B, PK_D, sari, wulan } from "./conversationTestData";

const chat = vi.hoisted(() => ({ createGroup: vi.fn() }));
const org = vi.hoisted(() => ({ people: vi.fn() }));

vi.mock("../../api/chat", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/chat")>()),
  chatApi: chat,
}));

vi.mock("../../api/org", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/org")>()),
  orgApi: org,
}));

function renderDialog() {
  const onOpenChange = vi.fn();
  const onCreated = vi.fn();
  render(
    <NewGroupDialog open onOpenChange={onOpenChange} people={[sari, budi, dimas, wulan]} onCreated={onCreated} />,
  );
  return { onOpenChange, onCreated };
}

const box = (name: RegExp) => screen.getByRole("checkbox", { name });
const visibleNames = () =>
  within(screen.getByRole("list", { name: "Rekan" }))
    .getAllByRole("checkbox")
    .map((c) => c.closest("label")!.querySelector(".pick-name")!.textContent);

beforeEach(() => {
  chat.createGroup.mockResolvedValue(group());
  org.people.mockResolvedValue(orgPeople);
});

describe("Dialog Grup baru", () => {
  it("fokus awal di nama grup, daftar urut nama, departemen di bawah nama", async () => {
    renderDialog();
    expect(screen.getByRole("dialog", { name: "Grup baru" })).toBeInTheDocument();
    expect(screen.getByLabelText("Nama grup")).toHaveFocus();
    expect(visibleNames()).toEqual(["Budi Uji", "Dimas Uji", "Sari Uji", "Wulan Uji"]);
    expect(await screen.findByRole("button", { name: "Drafting" })).toBeInTheDocument();
    expect(box(/Dimas Uji/).closest("label")).toHaveTextContent("Desain");
    expect(
      screen.getByText(
        "Belum ada yang dipilih. Grup bisa dibuat berisi Anda saja, lalu tambah orang belakangan. Tamu tidak bisa dimasukkan ke grup.",
      ),
    ).toBeInTheDocument();
  });

  it("cari nama di semua departemen", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(await screen.findByRole("button", { name: "Keuangan" }));
    expect(visibleNames()).toEqual(["Wulan Uji"]);
    await user.type(screen.getByLabelText("Pilih orang"), "dim");
    // Mencari mengembalikan saringan ke Semua, jadi Dimas (Desain) ketemu.
    expect(visibleNames()).toEqual(["Dimas Uji"]);
    expect(screen.getByRole("button", { name: "Semua" })).toHaveAttribute("aria-pressed", "false");
    await user.clear(screen.getByLabelText("Pilih orang"));
    await user.type(screen.getByLabelText("Pilih orang"), "zzz");
    expect(screen.getByText('Tidak ada rekan bernama "zzz".')).toBeInTheDocument();
  });

  it("chip departemen menyaring daftar", async () => {
    const user = userEvent.setup();
    renderDialog();
    const drafting = await screen.findByRole("button", { name: "Drafting" });
    expect(screen.getByRole("button", { name: "Semua" })).toHaveAttribute("aria-pressed", "true");
    await user.click(drafting);
    expect(drafting).toHaveAttribute("aria-pressed", "true");
    expect(visibleNames()).toEqual(["Budi Uji", "Sari Uji"]);
    await user.click(screen.getByRole("button", { name: "Semua" }));
    expect(visibleNames()).toHaveLength(4);
  });

  it("orang terpilih tetap tampil sebagai chip saat saringan diganti, dan bisa dilepas", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(box(/Sari Uji/));
    await user.click(box(/Dimas Uji/));
    expect(screen.getByText("2 orang dipilih, ditambah Anda. Tamu tidak bisa dimasukkan ke grup.")).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "Keuangan" }));
    expect(screen.queryByRole("checkbox", { name: /Sari Uji/ })).toBeNull();
    const chips = screen.getByRole("list", { name: "Orang yang dipilih" });
    expect(within(chips).getByText("Dimas Uji")).toBeInTheDocument();
    expect(within(chips).getByText("Sari Uji")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Hapus Sari Uji dari pilihan" }));
    expect(within(chips).queryByText("Sari Uji")).toBeNull();
    expect(screen.getByText("1 orang dipilih, ditambah Anda. Tamu tidak bisa dimasukkan ke grup.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Semua" }));
    expect(box(/Sari Uji/)).not.toBeChecked();
    expect(box(/Dimas Uji/)).toBeChecked();
  });

  it("tanpa nama: pesan di kolom, API tidak dipanggil", async () => {
    const user = userEvent.setup();
    renderDialog();
    const submit = screen.getByRole("button", { name: "Buat grup" });
    expect(submit).toHaveAttribute("aria-disabled", "true");
    await user.click(submit);
    expect(screen.getByText("Isi nama grup.")).toBeInTheDocument();
    expect(screen.queryByText("Pilih minimal satu orang.")).toBeNull();
    expect(screen.getByLabelText("Nama grup")).toHaveAttribute("aria-invalid", "true");
    expect(chat.createGroup).not.toHaveBeenCalled();
  });

  it("tanpa orang dipilih: grup dibuat berisi saya saja", async () => {
    const user = userEvent.setup();
    const { onCreated } = renderDialog();
    await user.type(screen.getByLabelText("Nama grup"), "Catatan pribadi");
    const submit = screen.getByRole("button", { name: "Buat grup" });
    expect(submit).not.toHaveAttribute("aria-disabled");
    await user.click(submit);
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(group()));
    expect(chat.createGroup).toHaveBeenCalledTimes(1);
    expect(chat.createGroup).toHaveBeenCalledWith("Catatan pribadi", []);
  });

  it("Buat grup mengirim nama yang dirapikan dan kunci orang terpilih", async () => {
    const user = userEvent.setup();
    const { onCreated } = renderDialog();
    await user.type(screen.getByLabelText("Nama grup"), "  Persiapan   pameran ");
    await user.click(box(/Sari Uji/));
    await user.click(box(/Dimas Uji/));
    await user.click(screen.getByRole("button", { name: "Buat grup" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(group()));
    expect(chat.createGroup).toHaveBeenCalledTimes(1);
    const [name, keys] = chat.createGroup.mock.calls[0];
    expect(name).toBe("Persiapan pameran");
    expect([...keys].sort()).toEqual([PK_B, PK_D].sort());
  });

  it("error dari inti Rust tampil, pilihan tetap ada", async () => {
    const user = userEvent.setup();
    chat.createGroup.mockRejectedValue({ code: "guest_not_allowed", message: "Tamu tidak bisa dimasukkan ke grup." });
    const { onCreated } = renderDialog();
    await user.type(screen.getByLabelText("Nama grup"), "Rapat");
    await user.click(box(/Budi Uji/));
    await user.click(screen.getByRole("button", { name: "Buat grup" }));
    expect(await screen.findByText("Grup belum dibuat")).toBeInTheDocument();
    expect(screen.getAllByText("Tamu tidak bisa dimasukkan ke grup.").length).toBeGreaterThan(0);
    expect(box(/Budi Uji/)).toBeChecked();
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("data departemen gagal dimuat: tanpa chip, daftar tetap bisa dipakai", async () => {
    org.people.mockRejectedValue({ code: "x", message: "gagal" });
    renderDialog();
    await waitFor(() => expect(org.people).toHaveBeenCalled());
    expect(screen.queryByRole("group", { name: "Saring menurut departemen" })).toBeNull();
    expect(visibleNames()).toHaveLength(4);
  });

  it("Escape menutup dialog", async () => {
    const user = userEvent.setup();
    const { onOpenChange } = renderDialog();
    await user.keyboard("{Escape}");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("tanpa rekan: catatan, tanpa daftar", () => {
    render(<NewGroupDialog open onOpenChange={() => {}} people={[]} onCreated={() => {}} />);
    expect(
      screen.getByText("Belum ada rekan lain yang bisa dimasukkan ke grup. Tamu tidak bisa dimasukkan ke grup."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Rekan" })).toBeNull();
  });
});
