import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Candidate, ImportedPdf, RequestDetail } from "../../api/signing";
import { NewRequestDialog, SIGNERS_MAX, titleFromFileName } from "./NewRequestDialog";

const api = vi.hoisted(() => ({ listCandidates: vi.fn(), createRequest: vi.fn() }));
vi.mock("../../api/signing", async (orig) => ({
  ...(await orig<typeof import("../../api/signing")>()),
  signingApi: api,
}));

// Data uji: nama dan kunci jelas buatan.
const ME_KEY = "a".repeat(64);
const KEY_B = "b".repeat(64);
const KEY_C = "c".repeat(64);
const candidates: Candidate[] = [
  { publicKey: KEY_C, displayName: "Tamu Uji", kind: "guest", isMe: false },
  { publicKey: ME_KEY, displayName: "Penguji", kind: "member", isMe: true },
  { publicKey: KEY_B, displayName: "Anggota Uji", kind: "member", isMe: false },
];
const imported: ImportedPdf = { fileHash: "f".repeat(64), size: 2048, fileName: "Kontrak Uji.PDF" };
const created = { id: "9".repeat(32) } as RequestDetail;

function setup() {
  const onCreated = vi.fn();
  const onOpenChange = vi.fn();
  const user = userEvent.setup();
  render(<NewRequestDialog open onOpenChange={onOpenChange} imported={imported} onCreated={onCreated} />);
  return { user, onCreated, onOpenChange };
}

function orderNames(): string[] {
  const list = screen.getByRole("list", { name: "Urutan" });
  return within(list)
    .getAllByRole("listitem")
    .map((li) => within(li).getAllByRole("button")[0].getAttribute("aria-label")?.replace(/^Naikkan /, "") ?? "");
}

beforeEach(() => {
  api.listCandidates.mockReset().mockResolvedValue(candidates);
  api.createRequest.mockReset().mockResolvedValue(created);
});

describe("NewRequestDialog", () => {
  it("judul bawaan dari nama file, diri sendiri tercentang, Tamu berlabel", async () => {
    setup();
    expect(titleFromFileName("a.pdf")).toBe("a");
    expect(screen.getByLabelText("Judul dokumen")).toHaveValue("Kontrak Uji");
    expect(screen.getByLabelText("Judul dokumen")).toHaveFocus();
    expect(screen.getByText(/2 KB/)).toBeInTheDocument();
    const me = await screen.findByRole("checkbox", { name: "Penguji (Anda)" });
    expect(me).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Tamu Uji/ })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Tamu Uji, Tamu" })).toBeInTheDocument();
    // Hanya diri sendiri: tanpa catatan pengiriman dan tanpa daftar urutan.
    expect(screen.queryByText(/Rekan baru menerimanya/)).not.toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Urutan" })).not.toBeInTheDocument();
  });

  it("urutan bisa dinaikkan dan diturunkan, fokus ikut baris yang dipindah", async () => {
    const { user, onCreated } = setup();
    await user.click(await screen.findByRole("checkbox", { name: "Anggota Uji" }));
    await user.click(screen.getByRole("checkbox", { name: /Tamu Uji/ }));
    expect(orderNames()).toEqual(["Penguji", "Anggota Uji", "Tamu Uji"]);
    expect(screen.getByText(/Rekan baru menerimanya setelah pengiriman lewat jaringan tersedia/)).toBeInTheDocument();

    expect(screen.getByRole("button", { name: "Naikkan Penguji" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Naikkan Tamu Uji" }));
    expect(orderNames()).toEqual(["Penguji", "Tamu Uji", "Anggota Uji"]);
    await user.click(screen.getByRole("button", { name: "Naikkan Tamu Uji" }));
    expect(orderNames()).toEqual(["Tamu Uji", "Penguji", "Anggota Uji"]);
    // Sudah paling atas: Naikkan nonaktif, fokus pindah ke Turunkan baris yang sama.
    expect(screen.getByRole("button", { name: "Turunkan Tamu Uji" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(orderNames()).toEqual(["Penguji", "Tamu Uji", "Anggota Uji"]);

    await user.click(screen.getByRole("button", { name: "Buat permintaan" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(created));
    expect(api.createRequest).toHaveBeenCalledWith({
      title: "Kontrak Uji",
      fileHash: imported.fileHash,
      mode: "sequential",
      signers: [ME_KEY, KEY_C, KEY_B],
    });
  });

  it("mode Bebas dikirim dan daftar urutan disembunyikan", async () => {
    const { user } = setup();
    await user.click(await screen.findByRole("checkbox", { name: "Anggota Uji" }));
    expect(screen.getByRole("list", { name: "Urutan" })).toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: "Bebas" }));
    expect(screen.getByText(/Siapa saja boleh lebih dulu/)).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Urutan" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Buat permintaan" }));
    await waitFor(() => expect(api.createRequest).toHaveBeenCalled());
    expect(api.createRequest.mock.calls[0][0]).toMatchObject({ mode: "parallel", signers: [ME_KEY, KEY_B] });
  });

  it("judul kosong dan tanpa penanda tangan ditolak sebelum memanggil inti", async () => {
    const { user } = setup();
    const me = await screen.findByRole("checkbox", { name: "Penguji (Anda)" });
    // Wadah alert sudah ada sebelum error muncul, supaya pembaca layar membacakan isinya.
    const alerts = screen.getAllByRole("alert");
    expect(alerts.every((a) => a.textContent === "")).toBe(true);
    await user.clear(screen.getByLabelText("Judul dokumen"));
    await user.click(screen.getByRole("button", { name: "Buat permintaan" }));
    expect(alerts.some((a) => a.textContent === "Isi judul dokumen.")).toBe(true);
    expect(screen.getByLabelText("Judul dokumen")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText("Judul dokumen")).toHaveFocus();

    await user.type(screen.getByLabelText("Judul dokumen"), "Judul Uji");
    await user.click(me);
    await user.click(screen.getByRole("button", { name: "Buat permintaan" }));
    expect(alerts.some((a) => a.textContent === "Pilih minimal satu penanda tangan.")).toBe(true);
    expect(api.createRequest).not.toHaveBeenCalled();
  });

  it("paling banyak 20 penanda tangan: centang ke-21 ditolak dengan pesan", async () => {
    const many: Candidate[] = Array.from({ length: SIGNERS_MAX + 1 }, (_, i) => ({
      publicKey: String(i).padStart(64, "0"),
      displayName: `Anggota Uji ${String(i).padStart(2, "0")}`,
      kind: "member",
      isMe: false,
    }));
    api.listCandidates.mockResolvedValueOnce(many);
    const { user } = setup();
    await screen.findByRole("checkbox", { name: "Anggota Uji 00" });
    expect(screen.getByText(`Paling banyak ${SIGNERS_MAX} orang. Dipilih 0.`)).toBeInTheDocument();
    for (let i = 0; i < SIGNERS_MAX; i++) {
      await user.click(screen.getByRole("checkbox", { name: `Anggota Uji ${String(i).padStart(2, "0")}` }));
    }
    expect(screen.getByText(`Paling banyak ${SIGNERS_MAX} orang. Dipilih ${SIGNERS_MAX}.`)).toBeInTheDocument();
    const last = screen.getByRole("checkbox", { name: "Anggota Uji 20" });
    await user.click(last);
    expect(last).not.toBeChecked();
    expect(screen.getByText(/Paling banyak 20 penanda tangan per permintaan/).closest("[role=alert]")).not.toBeNull();
    // Melepas satu centang menghapus pesan dan membuka tempat.
    await user.click(screen.getByRole("checkbox", { name: "Anggota Uji 00" }));
    expect(screen.queryByText(/Paling banyak 20 penanda tangan per permintaan/)).not.toBeInTheDocument();
    await user.click(last);
    expect(last).toBeChecked();
  });

  it("error dari inti ditampilkan dan dialog tetap terbuka", async () => {
    api.createRequest.mockRejectedValueOnce({ code: "request_invalid", message: "Judul berisi baris baru." });
    const { user, onCreated } = setup();
    await screen.findByRole("checkbox", { name: "Penguji (Anda)" });
    await user.click(screen.getByRole("button", { name: "Buat permintaan" }));
    expect(await screen.findByText("Judul berisi baris baru.")).toBeInTheDocument();
    expect(screen.getByText("Permintaan belum dibuat")).toBeInTheDocument();
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("daftar anggota gagal dibaca bisa dicoba lagi", async () => {
    api.listCandidates.mockRejectedValueOnce({ code: "database", message: "Database terkunci." });
    const { user } = setup();
    expect(await screen.findByText("Database terkunci.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Buat permintaan" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Coba lagi" }));
    expect(await screen.findByRole("checkbox", { name: "Penguji (Anda)" })).toBeChecked();
  });
});
