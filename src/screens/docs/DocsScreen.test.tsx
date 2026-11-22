import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  downloadVersion: vi.fn(),
  subscribeDocuments: vi.fn((_handler: () => void): (() => void) => () => {}),
}));
vi.mock("../../api/documents", () => docsApi);

// Event Tauri untuk sinkron fitur (mira://feature). Hanya dipakai kalau tes
// memasang __TAURI_INTERNALS__; di tes lain subscribeFeature tidak berlangganan.
const tauriEvent = vi.hoisted(() => ({
  handlers: [] as { event: string; fn: (e: { payload: unknown }) => void }[],
  listen: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: tauriEvent.listen }));

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
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  tauriEvent.handlers = [];
  tauriEvent.listen.mockReset().mockImplementation(async (event: string, fn: (e: { payload: unknown }) => void) => {
    const entry = { event, fn };
    tauriEvent.handlers.push(entry);
    return () => {
      tauriEvent.handlers = tauriEvent.handlers.filter((h) => h !== entry);
    };
  });
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

function emitFeature(topic: string) {
  act(() => {
    for (const h of tauriEvent.handlers.filter((x) => x.event === "mira://feature")) h.fn({ payload: { topic } });
  });
}

// Versi dari rekan yang isinya belum ada di laptop ini.
const MB = 1024 * 1024;
const besar = summary("d6", "gambar-kerja.docx", {
  current: version("d6", 2, {
    isHead: true,
    author: rekanC,
    received: true,
    available: false,
    autoDownload: false,
    size: 45 * MB,
  }),
  versionCount: 2,
});
const kecil = summary("d7", "notulen.docx", {
  current: version("d7", 2, { isHead: true, author: rekanC, received: true, available: false, downloading: true }),
  versionCount: 2,
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
    // Pembuat tiap versi terbaca di judul kartu.
    expect(within(heads[0]).getByText("Versi 5 dari Anda")).toBeInTheDocument();
    expect(within(heads[1]).getByText("Versi 4 dari Rekan C")).toBeInTheDocument();

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

  it("event mira://feature memuat ulang hanya untuk topik docs", async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    setup([laporan]);
    render(<DocsScreen />);
    await screen.findByText("Versi 3 · Diubah Anda 5 menit lalu");
    // Daftar dan panel detail masing-masing berlangganan.
    await waitFor(() => expect(tauriEvent.handlers.filter((h) => h.event === "mira://feature")).toHaveLength(2));
    const before = docsApi.listDocuments.mock.calls.length;

    emitFeature("sign");
    emitFeature("board");
    await act(async () => {});
    expect(docsApi.listDocuments.mock.calls.length).toBe(before);

    docsApi.listDocuments.mockResolvedValue([{ ...laporan, editing: [{ editor: rekanC, since: new Date().toISOString(), local: false, lastSavedAt: null }] }]);
    emitFeature("docs");
    expect(await screen.findByText(/Sedang diedit Rekan C/)).toBeInTheDocument();
    expect(docsApi.listDocuments.mock.calls.length).toBeGreaterThan(before);
  });

  it("versi besar dari rekan: tanpa Edit dan Buka, tombol unduh sibuk lalu berhasil", async () => {
    const user = userEvent.setup();
    setup([besar]);
    let finish: (value: DocumentSummary) => void = () => {};
    docsApi.downloadVersion.mockImplementation(() => new Promise<DocumentSummary>((resolve) => (finish = resolve)));
    render(<DocsScreen />);

    await screen.findByText("gambar-kerja.docx", { selector: ".doc-name" });
    const r = row("gambar-kerja.docx");
    expect(within(r).getByText("Versi 2 belum diunduh (45 MB)")).toBeInTheDocument();
    expect(within(r).queryByRole("button", { name: /^Edit di/ })).toBeNull();
    expect(within(r).queryByRole("button", { name: /^Buka/ })).toBeNull();
    const rowDownload = within(r).getByRole("button", { name: "Unduh dari rekan (45 MB) gambar-kerja.docx" });

    const history = await screen.findByRole("list", { name: "Riwayat versi gambar-kerja.docx" });
    const v2 = within(history).getAllByRole("listitem")[0];
    expect(within(v2).getByText("Versi 2")).toBeInTheDocument();
    expect(within(v2).getByText(/File di atas 20 MB tidak disalin otomatis/)).toBeInTheDocument();
    expect(within(v2).queryByRole("button", { name: "Buka versi 2" })).toBeNull();
    expect(within(v2).queryByRole("button", { name: "Simpan salinan versi 2" })).toBeNull();
    // Versi 1 dari laptop ini tetap bisa dibuka.
    expect(within(history).getByRole("button", { name: "Buka versi 1" })).toBeInTheDocument();

    const download = within(v2).getByRole("button", { name: "Unduh versi 2 dari rekan, 45 MB" });
    await user.click(download);
    expect(docsApi.downloadVersion).toHaveBeenCalledWith("d6", "d6-v2");
    expect(download).toHaveAttribute("aria-busy", "true");
    expect(download).toHaveTextContent("Mengunduh...");
    expect(download).toHaveFocus();
    expect(rowDownload).toHaveAttribute("aria-disabled", "true");
    // Klik kedua selama mengunduh ditolak.
    await user.click(rowDownload);
    expect(docsApi.downloadVersion).toHaveBeenCalledTimes(1);

    const done = { ...besar, current: { ...besar.current, available: true } };
    docsApi.listDocuments.mockResolvedValue([done]);
    await act(async () => finish(done));
    expect(await screen.findByText("Isi versi 2 dari gambar-kerja.docx sudah ada di laptop ini.")).toBeInTheDocument();
    expect(await within(row("gambar-kerja.docx")).findByRole("button", { name: "Edit di Word gambar-kerja.docx" })).toBeInTheDocument();
  });

  it("unduhan gagal karena tidak ada rekan yang menyimpan file: pesan dengan kata biasa", async () => {
    const user = userEvent.setup();
    setup([besar]);
    docsApi.downloadVersion.mockRejectedValue({ code: "not_available", message: "peer blob unavailable" });
    render(<DocsScreen />);

    await user.click(await screen.findByRole("button", { name: "Unduh versi 2 dari rekan, 45 MB" }));
    expect(await screen.findByText("File belum bisa diunduh")).toBeInTheDocument();
    expect(screen.getByText("Belum ada laptop rekan yang tersambung dan menyimpan file ini.")).toBeInTheDocument();
    expect(screen.getByText(/Coba lagi saat laptop rekan yang menyimpan versi ini menyala/)).toBeInTheDocument();
    expect(screen.queryByText("peer blob unavailable")).toBeNull();
  });

  it("versi kecil dari rekan yang sedang disalin: status tenang, tanpa tombol", async () => {
    setup([kecil]);
    render(<DocsScreen />);
    await screen.findByText("notulen.docx", { selector: ".doc-name" });
    const r = row("notulen.docx");
    expect(within(r).getByText("Versi 2 sedang disalin dari laptop rekan")).toBeInTheDocument();
    // Hanya tombol pilih file; tidak ada Edit, Buka, atau Unduh.
    expect(within(r).getAllByRole("button")).toHaveLength(1);

    const history = await screen.findByRole("list", { name: "Riwayat versi notulen.docx" });
    const v2 = within(history).getAllByRole("listitem")[0];
    expect(within(v2).getByText("Isinya sedang disalin dari laptop rekan.")).toBeInTheDocument();
    expect(within(v2).queryByRole("button")).toBeNull();
  });

  it("bentrok dengan versi rekan yang isinya masih disalin", async () => {
    const v4copy = version("d4", 4, { isHead: true, author: rekanC, received: true, available: false, downloading: true });
    setup([{ ...kontrak, conflictVersions: [v5, v4copy] }]);
    render(<DocsScreen />);

    const box = await screen.findByRole("group", { name: "Dua versi tersimpan berdampingan" });
    const heads = within(box).getAllByRole("listitem");
    expect(within(heads[1]).getByText("Versi 4 dari Rekan C")).toBeInTheDocument();
    expect(within(heads[1]).getByText("Isinya sedang disalin dari laptop rekan.")).toBeInTheDocument();
    expect(within(heads[1]).getByText("Versi ini bisa dipilih setelah isinya ada di laptop ini.")).toBeInTheDocument();
    expect(within(heads[1]).queryByRole("button")).toBeNull();
    // Versi di laptop ini tetap bisa dipilih, digabung, dan dibuka.
    expect(within(heads[0]).getByRole("button", { name: "Pakai versi ini (versi 5)" })).toBeInTheDocument();
    expect(within(heads[0]).getByRole("button", { name: "Gabung manual dari versi 5" })).toBeInTheDocument();
    expect(within(heads[0]).getByRole("button", { name: "Buka versi 5" })).toBeInTheDocument();
  });
});
