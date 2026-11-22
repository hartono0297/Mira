import {
  IconCloudOff,
  IconDeviceFloppy,
  IconDownload,
  IconExternalLink,
  IconFile,
  IconFileTypeDoc,
  IconFileTypePdf,
  IconFileTypePpt,
  IconFileTypeXls,
  IconFileZip,
  IconLoader2,
  IconPhoto,
  type Icon,
} from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import { toAppError, type AppError } from "../../api";
import { chatApi, type FileView } from "../../api/chat";
import { fileKind, formatSize, type FileKind } from "./text";

const KIND_ICONS: Record<FileKind, Icon> = {
  pdf: IconFileTypePdf,
  image: IconPhoto,
  word: IconFileTypeDoc,
  excel: IconFileTypeXls,
  slides: IconFileTypePpt,
  archive: IconFileZip,
  other: IconFile,
};

type Busy = "open" | "save" | "download" | null;

type Props = {
  // Pesan yang membawa file ini; dipakai untuk membukanya.
  messageId: string;
  file: FileView;
  // Dipanggil setelah unduhan selesai supaya keadaan file dimuat ulang.
  onDownloaded: () => void;
};

export function FileCard({ messageId, file, onDownloaded }: Props) {
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<{ action: Busy; error: AppError } | null>(null);
  const [saved, setSaved] = useState(false);
  const alive = useRef(true);
  const Glyph = KIND_ICONS[fileKind(file.mime, file.name)];
  const size = formatSize(file.size);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  async function run(action: Exclude<Busy, null>, work: () => Promise<boolean>) {
    if (busy) return;
    setBusy(action);
    setError(null);
    setSaved(false);
    try {
      const done = await work();
      if (done && action === "download") onDownloaded();
    } catch (err) {
      if (alive.current) setError({ action, error: toAppError(err) });
    } finally {
      if (alive.current) setBusy(null);
    }
  }

  const openFile = () =>
    run("open", async () => {
      await chatApi.fileOpen(messageId, file.hash);
      return true;
    });

  const saveFile = () =>
    run("save", async () => {
      // Dialog "Simpan sebagai" dibuka inti Rust; false berarti dibatalkan.
      const done = await chatApi.fileSave(file.hash);
      if (done && alive.current) setSaved(true);
      return done;
    });

  const download = () =>
    run("download", async () => {
      await chatApi.fileDownload(file.hash);
      return true;
    });

  const errorTitle =
    error?.action === "open"
      ? "File belum bisa dibuka"
      : error?.action === "save"
        ? "File belum tersimpan"
        : "File belum bisa diunduh";

  return (
    <div className="conv-file">
      <div className="conv-file-main">
        <Glyph size={22} className="conv-file-icon" aria-hidden="true" />
        <div className="conv-file-info">
          <p className="conv-file-name">{file.name}</p>
          <p className="conv-file-meta">
            {size}
            {file.state === "fetching" && (
              <span className="conv-file-busy">
                <IconLoader2 size={14} className="conv-spin" aria-hidden="true" />
                Mengunduh...
              </span>
            )}
          </p>
        </div>
        {file.state === "local" && (
          <div className="conv-file-actions">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => void openFile()}
              aria-disabled={busy !== null || undefined}
              aria-busy={busy === "open" || undefined}
              aria-label={`Buka ${file.name}`}
            >
              <IconExternalLink size={16} aria-hidden="true" />
              {busy === "open" ? "Membuka..." : "Buka"}
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => void saveFile()}
              aria-disabled={busy !== null || undefined}
              aria-busy={busy === "save" || undefined}
              aria-label={`Simpan ${file.name} sebagai`}
            >
              <IconDeviceFloppy size={16} aria-hidden="true" />
              {busy === "save" ? "Menyimpan..." : "Simpan"}
            </button>
          </div>
        )}
        {file.state === "remote" && (
          <div className="conv-file-actions">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => void download()}
              aria-disabled={busy !== null || undefined}
              aria-busy={busy === "download" || undefined}
              aria-label={`Unduh ${file.name}`}
            >
              {busy === "download" ? (
                <IconLoader2 size={16} className="conv-spin" aria-hidden="true" />
              ) : (
                <IconDownload size={16} aria-hidden="true" />
              )}
              {busy === "download" ? "Mengunduh..." : "Unduh"}
            </button>
          </div>
        )}
      </div>
      {file.state === "missing" && (
        <p className="conv-file-note">
          <IconCloudOff size={14} aria-hidden="true" />
          Belum tersedia. File diunduh otomatis saat laptop rekan yang menyimpannya online.
        </p>
      )}
      <div aria-live="polite">
        {saved && <p className="conv-file-note">{file.name} tersimpan.</p>}
        {error && (
          <p className="conv-file-error" role="alert">
            <strong>{errorTitle}.</strong> {error.error.message}
          </p>
        )}
      </div>
    </div>
  );
}
