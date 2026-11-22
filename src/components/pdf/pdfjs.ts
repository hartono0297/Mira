import type { PDFDocumentProxy } from "pdfjs-dist";
// Worker dibundel Vite sebagai aset lokal (tidak ada CDN; aplikasi offline penuh).
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

// Data pendukung pdf.js (cMaps, font standar, wasm, profil ICC) disalin ke
// dist/pdfjs/ oleh plugin kecil di vite.config.ts dan dilayani dari folder
// yang sama saat `vite` dev. Semua dari origin sendiri, sesuai CSP 'self'.
//
// pdf.js 6 tidak lagi punya opsi `isEvalSupported`: kode eval/new Function
// sudah dihapus dari pustakanya, jadi tidak ada yang perlu dimatikan.

let lib: Promise<typeof import("pdfjs-dist")> | null = null;

// pdf.js dimuat malas supaya tidak memperberat awal aplikasi dan supaya tes
// jsdom yang hanya mengimpor komponen tidak ikut memuat pustakanya.
function pdfjs(): Promise<typeof import("pdfjs-dist")> {
  if (!lib) {
    lib = import("pdfjs-dist").then((mod) => {
      mod.GlobalWorkerOptions.workerSrc = workerUrl;
      return mod;
    });
    lib.catch(() => {
      lib = null;
    });
  }
  return lib;
}

function assetBase(): string {
  return new URL(`${import.meta.env.BASE_URL}pdfjs/`, document.baseURI).href;
}

// Build modern pdf.js memakai API JavaScript baru (mis. Map.getOrInsertComputed)
// tanpa polyfill. WebView2 yang terlalu lama tidak punya API itu.
function runtimeSupported(): boolean {
  return typeof (Map.prototype as { getOrInsertComputed?: unknown }).getOrInsertComputed === "function";
}

export class PdfLoadError extends Error {
  readonly kind: PdfErrorKind;
  constructor(kind: PdfErrorKind, message: string) {
    super(message);
    this.name = "PdfLoadError";
    this.kind = kind;
  }
}

export type PdfErrorKind = "empty" | "invalid" | "password" | "runtime" | "unknown";

export type LoadOptions = {
  // Membatalkan pemuatan (mis. komponen dilepas sebelum selesai).
  signal?: AbortSignal;
};

export type LoadedPdf = {
  doc: PDFDocumentProxy;
  // Melepas dokumen dan mematikan worker-nya. pdf.js 6 memindahkan destroy()
  // dari dokumen ke loadingTask; fungsi ini membungkusnya.
  destroy: () => Promise<void>;
};

// Membuka PDF dari byte. Buffer disalin dulu karena pdf.js memindahkan
// (transfer) buffer ke worker, sehingga milik pemanggil akan kosong.
// Bersihkan hasilnya dengan `destroy()`.
export async function loadPdf(data: Uint8Array, options: LoadOptions = {}): Promise<LoadedPdf> {
  if (data.byteLength === 0) throw new PdfLoadError("empty", "File kosong (0 byte).");
  if (!runtimeSupported()) throw new PdfLoadError("runtime", "WebView2 terlalu lama untuk pdf.js.");
  const { signal } = options;
  signal?.throwIfAborted();

  const mod = await pdfjs();
  signal?.throwIfAborted();

  const base = assetBase();
  const task = mod.getDocument({
    data: data.slice(),
    cMapUrl: `${base}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${base}standard_fonts/`,
    wasmUrl: `${base}wasm/`,
    iccUrl: `${base}iccs/`,
    enableXfa: false,
    verbosity: mod.VerbosityLevel.ERRORS,
  });
  const abort = () => void task.destroy();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const doc = await task.promise;
    return { doc, destroy: () => task.destroy() };
  } catch (err) {
    if (signal?.aborted) throw signal.reason;
    throw classify(err);
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}

function classify(err: unknown): PdfLoadError {
  const name = err instanceof Error ? err.name : "";
  const message = err instanceof Error ? err.message : String(err);
  if (name === "PasswordException") return new PdfLoadError("password", message);
  if (name === "InvalidPDFException") return new PdfLoadError("invalid", message);
  return new PdfLoadError("unknown", message);
}

export type PdfErrorText = { title: string; detail: string };

// Pesan untuk pengguna: penyebab dan langkah berikutnya.
export function describePdfError(err: unknown): PdfErrorText {
  const kind = err instanceof PdfLoadError ? err.kind : "unknown";
  switch (kind) {
    case "empty":
      return {
        title: "File PDF kosong",
        detail: "File ini berukuran 0 byte, jadi tidak ada isi yang bisa ditampilkan. Ambil lagi file aslinya, lalu buka ulang.",
      };
    case "invalid":
      return {
        title: "File ini bukan PDF atau rusak",
        detail:
          "Mira tidak menemukan struktur PDF yang bisa dibaca. Pastikan file berakhiran .pdf dan bisa dibuka di aplikasi lain. Kalau tidak bisa, minta pengirim mengirim ulang.",
      };
    case "password":
      return {
        title: "PDF dikunci kata sandi",
        detail: "Mira belum bisa membuka PDF yang dikunci. Buka kuncinya di aplikasi PDF lain, simpan tanpa kata sandi, lalu buka lagi di sini.",
      };
    case "runtime":
      return {
        title: "Komponen tampilan Windows perlu diperbarui",
        detail: "Microsoft Edge WebView2 di komputer ini terlalu lama untuk menampilkan PDF. Jalankan Windows Update atau pasang ulang Mira, lalu coba lagi.",
      };
    default: {
      const message = err instanceof Error && err.message ? ` (${err.message})` : "";
      return {
        title: "PDF tidak bisa dibuka",
        detail: `Terjadi kesalahan saat membaca file${message}. Tutup lalu buka lagi file ini. Kalau tetap gagal, file kemungkinan rusak.`,
      };
    }
  }
}

export function isRenderCancelled(err: unknown): boolean {
  return err instanceof Error && err.name === "RenderingCancelledException";
}
