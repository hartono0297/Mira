import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentDetail, DocumentSummary } from "../../api/documents";
import { DocsScreen } from "./DocsScreen";
import { detailOf, meRef, rekanC, summary, version } from "./testData";

const docsApi = vi.hoisted(() => ({
  listDocuments: vi.fn(),
  getDocument: vi.fn(),
  addDocuments: vi.fn(),
  startEdit: vi.fn(),
  finishEdit: vi.fn(),
  openReadOnly: vi.fn(),
  restoreVersion: vi.fn(),
  resolveConflict: vi.fn(),
  exportVersion: vi.fn(),
  pickFilesToAdd: vi.fn(),
  pickExportDestination: vi.fn(),
  subscribeDocuments: vi.fn((_handler: () => void): (() => void) => () => {}),
}));
vi.mock("../../api/documents", () => docsApi);

// Empat keadaan baris: biasa, diedit di laptop ini, diedit rekan, bentrok.
const laporan = summary("d1", "laporan-bulanan.docx", {
  current: version("d1", 3, { isHead: true, createdAt: new Date(Date.now() - 5 * 60_000).toISOString() }),
  versionCount: 3,
});
const rab = summary("d2", "RAB-proyek.xlsx", {
  editing: [{ editor: meRef, since: new Date().toISOString(), local: true, lastSavedAt: null }],
});
const jadwal = summary("d3", "jadwal.xlsx", {
  editing: [{ editor: rekanC, since: new Date().toISOString(), local: false, lastSavedAt: null }],
});
const v4 = version("d4", 4, { isHead: true, author: rekanC, received: true });
const v5 = version("d4", 5, { isHead: true, parentIds: ["d4-v3"] });
const kontrak = summary("d4", "kontrak.docx", {
  current: v5,
  versionCount: 5,
  conflict: true,
  conflictVersions: [v5, v4],
});
const brosur = summary("d5", "brosur.pdf");

function setup(docs: DocumentSummary[], details: Record<string, DocumentDetail> = {}) {
  docsApi.listDocuments.mockResolvedValue(docs);
  docsApi.getDocument.mockImplementation(async (id: string) => {
    const found = details[id] ?? docs.find((d) => d.id === id);
    if (!found) throw { code: "not_found", message: "Dokumen tidak ditemukan." };
    return "versions" in found ? found : detailOf(found);
  });
}

function row(name: string): HTMLElement {
  const item = screen.getByText(name, { selector: ".doc-name" }).closest("li");
  if (!item) throw new Error(`baris ${name} tidak ada`);
  return item;
}


beforeEach(() => {
  for (const fn of Object.values(docsApi)) fn.mockReset();
  docsApi.subscribeDocuments.mockImplementation(() => () => {});
});

describe("Layar Dokumen", () => {
  it("menampilkan daftar file dengan baris status tiap keadaan", async () => {
    setup([laporan, rab, jadwal, kontrak, brosur]);
    render(<DocsScreen />);

    expect(screen.getByRole("status")).toHaveTextContent("Memuat daftar dokumen...");
    expect(await screen.findByText("laporan-bulanan.docx", { selector: ".doc-name" })).toBeInTheDocument();
    expect(docsApi.listDocuments).toHaveBeenCalledWith(null);
    expect(screen.getByRole("heading", { level: 1, name: "Dokumen" })).toBeInTheDocument();
    expect(screen.getByText("Pustaka Umum")).toBeInTheDocument();

    expect(within(row("laporan-bulanan.docx")).getByText("Versi 3 · Diubah Anda 5 menit lalu")).toBeInTheDocument();
    expect(within(row("RAB-proyek.xlsx")).getByText(/^Sedang Anda edit di Excel sejak \d{2}\.\d{2}$/)).toBeInTheDocument();
    expect(within(row("jadwal.xlsx")).getByText(/^Sedang diedit Rekan C sejak \d{2}\.\d{2}$/)).toBeInTheDocument();
    expect(within(row("kontrak.docx")).getByText("Bentrok: versi 4 dan 5 tersimpan berdampingan")).toBeInTheDocument();
    expect(within(row("brosur.pdf")).getByText(/^Versi 1 · Ditambahkan Anda/)).toBeInTheDocument();

    // Tombol baris sesuai jenis dan keadaan.
    expect(within(row("laporan-bulanan.docx")).getByRole("button", { name: "Edit di Word laporan-bulanan.docx" })).toBeInTheDocument();
    expect(within(row("brosur.pdf")).getByRole("button", { name: "Buka brosur.pdf" })).toBeInTheDocument();
    expect(within(row("kontrak.docx")).getByRole("button", { name: "Selesaikan bentrok kontrak.docx" })).toBeInTheDocument();

    // File pertama terpilih dan riwayatnya tampil.
    expect(await screen.findByRole("heading", { level: 2, name: "laporan-bulanan.docx" })).toBeInTheDocument();
    const history = await screen.findByRole("list", { name: "Riwayat versi laporan-bulanan.docx" });
    expect(within(history).getAllByRole("listitem")).toHaveLength(3);
    expect(within(history).getByText("Sekarang")).toBeInTheDocument();
    expect(within(history).getByText("Ditambahkan")).toBeInTheDocument();
    expect(within(history).getAllByText("Disimpan dari Word")).toHaveLength(2);
    // Versi sekarang tidak bisa dipulihkan.
    expect(within(history).queryByRole("button", { name: "Pulihkan versi 3" })).toBeNull();
    expect(within(history).getByRole("button", { name: "Pulihkan versi 1" })).toBeInTheDocument();
  });

  it("Edit di Word membuka file untuk diedit", async () => {
    const user = userEvent.setup();
    setup([laporan]);
    docsApi.startEdit.mockResolvedValue(laporan);
    render(<DocsScreen />);
    await user.click(await screen.findByRole("button", { name: "Edit di Word laporan-bulanan.docx" }));
    expect(docsApi.startEdit).toHaveBeenCalledWith("d1", null);
    expect(await screen.findByText(/laporan-bulanan\.docx dibuka di Word/)).toBeInTheDocument();
  });

  it("file yang sedang Anda edit punya Buka lagi dan Selesai mengedit", async () => {
    const user = userEvent.setup();
    const rabDetail = detailOf({ ...rab, current: version("d2", 2, { isHead: true }), versionCount: 2 });
    setup([rab], { d2: rabDetail });
    docsApi.startEdit.mockResolvedValue(rab);
    docsApi.finishEdit.mockResolvedValue({ ...rab, editing: [] });
    render(<DocsScreen />);

    await screen.findByText("RAB-proyek.xlsx", { selector: ".doc-name" });
    const r = row("RAB-proyek.xlsx");
    expect(within(r).queryByRole("button", { name: /^Edit di/ })).toBeNull();
    await user.click(within(r).getByRole("button", { name: "Buka lagi RAB-proyek.xlsx" }));
    expect(docsApi.startEdit).toHaveBeenCalledWith("d2", null);

    await user.click(within(r).getByRole("button", { name: "Selesai mengedit RAB-proyek.xlsx" }));
    expect(docsApi.finishEdit).toHaveBeenCalledWith("d2");
    expect(await screen.findByText("Selesai mengedit RAB-proyek.xlsx. Rekan sekarang bisa mengeditnya.")).toBeInTheDocument();

    // Selama diedit, versi lama tidak bisa dipulihkan dari layar ini.
    expect(await screen.findByText(/setelah Anda menekan Selesai mengedit/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pulihkan versi 1" })).toBeNull();
  });

  it("file yang diedit rekan hanya bisa dibuka hanya baca", async () => {
    const user = userEvent.setup();
    setup([jadwal]);
    docsApi.openReadOnly.mockResolvedValue(null);
    render(<DocsScreen />);

    await screen.findByText("jadwal.xlsx", { selector: ".doc-name" });
    const r = row("jadwal.xlsx");
    expect(within(r).queryByRole("button", { name: /^Edit di/ })).toBeNull();
    await user.click(within(r).getByRole("button", { name: "Buka hanya baca jadwal.xlsx" }));
    expect(docsApi.openReadOnly).toHaveBeenCalledWith("d3", null);
    expect(await screen.findByText("jadwal.xlsx versi 1 dibuka hanya baca.")).toBeInTheDocument();
  });

  it("bentrok: dua versi berdampingan, Pakai versi ini memanggil resolve", async () => {
    const user = userEvent.setup();
    setup([kontrak]);
    const v6 = version("d4", 6, { isHead: true, origin: "resolved" });
    docsApi.resolveConflict.mockResolvedValue({ ...kontrak, current: v6, conflict: false, conflictVersions: [] });
    docsApi.startEdit.mockResolvedValue(kontrak);
    render(<DocsScreen />);

    const box = await screen.findByRole("group", { name: "Dua versi tersimpan berdampingan" });
    expect(within(box).getByText(/Versi 4 dan 5 dibuat terpisah/)).toBeInTheDocument();
    const heads = within(box).getAllByRole("listitem");
    expect(heads).toHaveLength(2);
    expect(within(heads[0]).getByText("Versi 5")).toBeInTheDocument();
    expect(within(heads[1]).getByText("Versi 4")).toBeInTheDocument();
    expect(within(heads[1]).getByText(/Rekan C/)).toBeInTheDocument();

    await user.click(within(box).getByRole("button", { name: "Gabung manual dari versi 4" }));
    expect(docsApi.startEdit).toHaveBeenCalledWith("d4", "d4-v4");

    await user.click(within(box).getByRole("button", { name: "Pakai versi ini (versi 5)" }));
    expect(docsApi.resolveConflict).toHaveBeenCalledWith("d4", "d4-v5");
    expect(await screen.findByText("Bentrok selesai. Versi 6 berisi isi versi 5.")).toBeInTheDocument();
  });

  it("Selesaikan bentrok di daftar memilih file dan memindah fokus ke kotak bentrok", async () => {
    const user = userEvent.setup();
    setup([laporan, kontrak]);
    render(<DocsScreen />);
    await screen.findByRole("heading", { level: 2, name: "laporan-bulanan.docx" });

    await user.click(within(row("kontrak.docx")).getByRole("button", { name: "Selesaikan bentrok kontrak.docx" }));
    const title = await screen.findByRole("heading", { level: 3, name: "Dua versi tersimpan berdampingan" });
    await waitFor(() => expect(title).toHaveFocus());
  });

  it("memulihkan versi lama meminta konfirmasi dulu", async () => {
    const user = userEvent.setup();
    setup([laporan]);
    const v4new = version("d1", 4, { isHead: true, origin: "restored", restoredFromNumber: 1 });
    docsApi.restoreVersion.mockResolvedValue({ ...laporan, current: v4new, versionCount: 4 });
    render(<DocsScreen />);

    await user.click(await screen.findByRole("button", { name: "Pulihkan versi 1" }));
    const dialog = await screen.findByRole("dialog", { name: "Pulihkan versi 1?" });
    expect(within(dialog).getByText(/Semua versi lain tetap ada di riwayat/)).toBeInTheDocument();
    expect(docsApi.restoreVersion).not.toHaveBeenCalled();

    // Batal tidak memulihkan apa pun.
    await user.click(within(dialog).getByRole("button", { name: "Batal" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(docsApi.restoreVersion).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Pulihkan versi 1" }));
    const again = await screen.findByRole("dialog", { name: "Pulihkan versi 1?" });
    await user.click(within(again).getByRole("button", { name: "Pulihkan versi 1" }));
    expect(docsApi.restoreVersion).toHaveBeenCalledWith("d1", "d1-v1");
    expect(await screen.findByText("Versi 1 dipulihkan menjadi versi 4.")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("error saat memulihkan tampil di dalam dialog", async () => {
    const user = userEvent.setup();
    setup([laporan]);
    docsApi.restoreVersion.mockRejectedValue({ code: "document_editing", message: "Dokumen sedang diedit." });
    render(<DocsScreen />);

    await user.click(await screen.findByRole("button", { name: "Pulihkan versi 2" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Pulihkan versi 2" }));
    expect(await within(dialog).findByText("Versi belum bisa dipulihkan")).toBeInTheDocument();
    expect(within(dialog).getByText("Dokumen sedang diedit.")).toBeInTheDocument();
  });

  it("Tambah file mengirim path pilihan ke pustaka Umum", async () => {
    const user = userEvent.setup();
    const added = [summary("n1", "notulen.docx"), summary("n2", "anggaran.xlsx")];
    setup([laporan]);
    docsApi.pickFilesToAdd.mockResolvedValue(["C:\\Data\\notulen.docx", "C:\\Data\\anggaran.xlsx"]);
    docsApi.addDocuments.mockImplementation(async () => {
      docsApi.listDocuments.mockResolvedValue([...added, laporan]);
      return added;
    });
    render(<DocsScreen />);

    await user.click(await screen.findByRole("button", { name: "Tambah file" }));
    expect(docsApi.addDocuments).toHaveBeenCalledWith(["C:\\Data\\notulen.docx", "C:\\Data\\anggaran.xlsx"], null);
    expect(await screen.findByText("2 file ditambahkan ke pustaka Umum.")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { level: 2, name: "notulen.docx" })).toBeInTheDocument();
  });

  it("membatalkan dialog pilih file tidak melakukan apa pun", async () => {
    const user = userEvent.setup();
    setup([laporan]);
    docsApi.pickFilesToAdd.mockResolvedValue(null);
    render(<DocsScreen />);

    await user.click(await screen.findByRole("button", { name: "Tambah file" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Tambah file" })).not.toHaveAttribute("aria-disabled"));
    expect(docsApi.addDocuments).not.toHaveBeenCalled();
    expect(screen.queryByText(/ditambahkan/)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("Simpan salinan memakai tujuan dari dialog simpan", async () => {
    const user = userEvent.setup();
    setup([laporan]);
    docsApi.pickExportDestination.mockResolvedValue("D:\\Arsip\\laporan-bulanan.docx");
    docsApi.exportVersion.mockResolvedValue(null);
    render(<DocsScreen />);

    await user.click(await screen.findByRole("button", { name: "Simpan salinan versi 2" }));
    expect(docsApi.pickExportDestination).toHaveBeenCalledWith("laporan-bulanan.docx");
    expect(docsApi.exportVersion).toHaveBeenCalledWith("d1", "d1-v2", "D:\\Arsip\\laporan-bulanan.docx");
    expect(await screen.findByText("Salinan versi 2 disimpan di D:\\Arsip\\laporan-bulanan.docx.")).toBeInTheDocument();
  });

  it("daftar yang gagal dibaca menampilkan error dan bisa dicoba lagi", async () => {
    const user = userEvent.setup();
    docsApi.listDocuments.mockRejectedValueOnce({ code: "database", message: "Database tidak bisa dibuka." });
    render(<DocsScreen />);

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("Daftar dokumen belum terbaca")).toBeInTheDocument();
    expect(within(alert).getByText("Database tidak bisa dibuka.")).toBeInTheDocument();

    setup([laporan]);
    await user.click(within(alert).getByRole("button", { name: "Coba baca lagi" }));
    expect(await screen.findByText("laporan-bulanan.docx", { selector: ".doc-name" })).toBeInTheDocument();
  });

  it("error aksi tampil lewat ErrorAlert dengan saran", async () => {
    const user = userEvent.setup();
    setup([rab]);
    docsApi.finishEdit.mockRejectedValue({ code: "document_editing", message: "Excel masih membuka file ini." });
    render(<DocsScreen />);

    await user.click(await screen.findByRole("button", { name: "Selesai mengedit RAB-proyek.xlsx" }));
    expect(await screen.findByText("Edit belum bisa diselesaikan")).toBeInTheDocument();
    expect(screen.getByText("Excel masih membuka file ini.")).toBeInTheDocument();
    expect(screen.getByText(/Tutup file di Word atau Excel dulu/)).toBeInTheDocument();
  });

  it("satu aksi pada satu waktu: tombol lain menunggu dan klik kedua ditolak", async () => {
    const user = userEvent.setup();
    setup([laporan, brosur]);
    let finish: (value: DocumentSummary) => void = () => {};
    docsApi.startEdit.mockImplementation(() => new Promise<DocumentSummary>((resolve) => (finish = resolve)));
    docsApi.openReadOnly.mockResolvedValue(null);
    render(<DocsScreen />);

    const edit = await screen.findByRole("button", { name: "Edit di Word laporan-bulanan.docx" });
    await user.click(edit);
    expect(edit).toHaveAttribute("aria-busy", "true");
    expect(edit).toHaveTextContent("Membuka...");
    // Tombol yang sibuk tidak memakai disabled, jadi fokus keyboard tetap di sana.
    expect(edit).not.toBeDisabled();
    expect(edit).toHaveFocus();

    const other = within(row("brosur.pdf")).getByRole("button", { name: "Buka brosur.pdf" });
    expect(other).toHaveAttribute("aria-disabled", "true");
    await user.click(other);
    await user.click(edit);
    expect(docsApi.openReadOnly).not.toHaveBeenCalled();
    expect(docsApi.startEdit).toHaveBeenCalledTimes(1);

    await act(async () => finish(laporan));
    await waitFor(() => expect(other).not.toHaveAttribute("aria-disabled"));
  });

  it("fokus pindah ke baris file kalau tombol yang ditekan hilang", async () => {
    const user = userEvent.setup();
    setup([rab]);
    docsApi.finishEdit.mockImplementation(async () => {
      docsApi.listDocuments.mockResolvedValue([{ ...rab, editing: [] }]);
      return { ...rab, editing: [] };
    });
    render(<DocsScreen />);

    await user.click(await screen.findByRole("button", { name: "Selesai mengedit RAB-proyek.xlsx" }));
    await screen.findByText(/^Selesai mengedit RAB-proyek\.xlsx\./);
    const pick = within(row("RAB-proyek.xlsx")).getByRole("button", { name: /^RAB-proyek\.xlsx/ });
    await waitFor(() => expect(pick).toHaveFocus());
  });

  it("tamu yang tidak bisa memilih versi hanya melihat bentrok", async () => {
    setup([{ ...kontrak, can: { edit: false, restore: false, resolve: false, export: true } }]);
    render(<DocsScreen />);
    await screen.findByText("kontrak.docx", { selector: ".doc-name" });
    expect(within(row("kontrak.docx")).getByRole("button", { name: "Lihat bentrok kontrak.docx" })).toBeInTheDocument();
    expect(await screen.findByText(/Anda tidak punya izin memilih versi/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Pakai versi ini/ })).toBeNull();
  });

  it("pustaka kosong menampilkan penjelasan dan satu tombol Tambah file", async () => {
    setup([]);
    render(<DocsScreen />);
    expect(await screen.findByRole("heading", { name: "Pustaka Umum masih kosong" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Tambah file" })).toHaveLength(1);
  });

  it("memuat ulang saat event dokumen datang dan saat jendela kembali fokus", async () => {
    // Daftar dan panel detail masing-masing berlangganan.
    const handlers = new Set<() => void>();
    docsApi.subscribeDocuments.mockImplementation((handler: () => void) => {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    });
    setup([laporan]);
    render(<DocsScreen />);
    await screen.findByText("Versi 3 · Diubah Anda 5 menit lalu");
    const before = docsApi.listDocuments.mock.calls.length;

    docsApi.listDocuments.mockResolvedValue([{ ...laporan, editing: [{ editor: rekanC, since: new Date().toISOString(), local: false, lastSavedAt: null }] }]);
    act(() => handlers.forEach((h) => h()));
    expect(await screen.findByText(/Sedang diedit Rekan C/)).toBeInTheDocument();
    expect(docsApi.listDocuments.mock.calls.length).toBeGreaterThan(before);

    const afterEvent = docsApi.listDocuments.mock.calls.length;
    fireEvent.focus(window);
    await waitFor(() => expect(docsApi.listDocuments.mock.calls.length).toBeGreaterThan(afterEvent));
  });
});
