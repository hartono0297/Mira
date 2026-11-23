import {
  IconAlertTriangle,
  IconCheck,
  IconCopy,
  IconDownload,
  IconEye,
  IconFileExport,
  IconHistory,
  IconLock,
  IconPencil,
} from "@tabler/icons-react";
import type { ReactNode } from "react";
import type { DocumentSummary } from "../../api/documents";
import { MenuButton, menuItems, SEPARATOR, useContextMenu, type MenuAction } from "../../components/ContextMenu";
import { isBlocked, isBusy, keys, type DocActions } from "./actions";
import { KindIcon } from "./KindIcon";
import {
  appName,
  COPY_NAME_LABEL,
  downloadLabel,
  editable,
  EXPORT_LABEL,
  exportBlockedReason,
  fetchState,
  HISTORY_LABEL,
  menuButtonLabel,
  menuLabel,
  OPEN_READONLY_LABEL,
  statusLines,
  WAIT_REASON,
  type StatusKind,
} from "./text";

type Props = {
  doc: DocumentSummary;
  selected: boolean;
  onSelect: () => void;
  actions: DocActions;
  now: Date;
};

function StatusIcon({ kind }: { kind: StatusKind }) {
  if (kind === "conflict") return <IconAlertTriangle size={14} aria-hidden="true" />;
  if (kind === "mine" || kind === "rekan") return <IconLock size={14} aria-hidden="true" />;
  if (kind === "fetch") return <IconDownload size={14} aria-hidden="true" />;
  return null;
}

// `id` juga menjadi id item di menu klik kanan (data-menu-item).
// `menuOnly`: hanya tampil di menu, tidak sebagai tombol di baris.
type Btn = {
  id: string;
  key: string;
  label: string;
  busyLabel: string;
  icon: ReactNode;
  run: () => void;
  menuOnly?: boolean;
};

const icon = (Icon: typeof IconPencil) => <Icon size={16} aria-hidden="true" />;

// Tombol di baris mengikuti keadaan file: bentrok, diedit di laptop ini,
// diedit rekan, atau biasa. Menu klik kanan memakai daftar yang sama.
function rowButtons(doc: DocumentSummary, actions: DocActions): Btn[] {
  const mine = doc.editing.find((e) => e.local);
  const rekan = doc.editing.find((e) => !e.local);
  const app = appName(doc.kind);
  if (mine) {
    return [
      {
        id: "edit",
        key: keys.edit(doc.id, null),
        label: "Buka lagi",
        busyLabel: "Membuka...",
        icon: icon(IconPencil),
        run: () => actions.edit(doc, null),
      },
      {
        id: "finish",
        key: keys.finish(doc.id),
        label: "Selesai mengedit",
        busyLabel: "Menyelesaikan...",
        icon: icon(IconCheck),
        run: () => actions.finish(doc),
      },
    ];
  }
  if (doc.conflict && doc.conflictVersions.length > 1) {
    // Tamu tidak bisa memilih atau menggabung, jadi tombolnya hanya menunjukkan bentrok.
    const canAct = doc.can.resolve || (editable(doc.kind) && doc.can.edit);
    const label = canAct ? "Selesaikan bentrok" : "Lihat bentrok";
    return [
      {
        id: "conflict",
        key: `conflict:${doc.id}`,
        label,
        busyLabel: label,
        icon: icon(IconAlertTriangle),
        run: () => actions.showConflict(doc),
      },
    ];
  }
  // Isi versi sekarang belum ada di laptop ini: Edit dan Buka tidak ditawarkan.
  // File di atas 20 MB punya tombol unduh; yang lain cukup baris status.
  const fetch = fetchState(doc.current);
  if (fetch === "manual") {
    return [
      {
        id: "download",
        key: keys.download(doc.id, doc.current.id),
        label: downloadLabel(doc.current),
        busyLabel: "Mengunduh...",
        icon: icon(IconDownload),
        run: () => actions.download(doc, doc.current),
      },
    ];
  }
  if (fetch) return [];
  const open: Btn = {
    id: "open",
    key: keys.open(doc.id, null),
    label: OPEN_READONLY_LABEL,
    busyLabel: "Membuka...",
    icon: icon(IconEye),
    run: () => actions.open(doc, null),
  };
  if (rekan || !editable(doc.kind) || !doc.can.edit) {
    return [{ ...open, label: rekan || editable(doc.kind) ? OPEN_READONLY_LABEL : "Buka" }];
  }
  return [
    {
      id: "edit",
      key: keys.edit(doc.id, null),
      label: `Edit di ${app}`,
      busyLabel: "Membuka...",
      icon: icon(IconPencil),
      run: () => actions.edit(doc, null),
    },
    // Hanya di menu: membuka tanpa mengunci file untuk rekan.
    { ...open, menuOnly: true },
  ];
}

// Alasan item menu nonaktif selama aksi berjalan: label sibuk untuk aksinya
// sendiri, atau keterangan menunggu untuk aksi lain.
function blockedReason(actions: DocActions, key: string, busyLabel: string): string | undefined {
  if (isBusy(actions, key)) return busyLabel;
  return isBlocked(actions, key) ? WAIT_REASON : undefined;
}

function menuEntries(doc: DocumentSummary, buttons: Btn[], actions: DocActions) {
  const conflict = doc.conflict && doc.conflictVersions.length > 1;
  const fetch = fetchState(doc.current);
  const exportKey = keys.export(doc.id, doc.current.id);
  // Saat bentrok, "versi sekarang" belum pasti; salinan per versi ada di panel detail.
  const exportItem: MenuAction | null =
    doc.can.export && !conflict
      ? {
          id: "export",
          label: EXPORT_LABEL,
          icon: icon(IconFileExport),
          disabled: fetch ? exportBlockedReason(fetch) : blockedReason(actions, exportKey, "Menyimpan..."),
          onSelect: () => actions.exportCopy(doc, doc.current),
        }
      : null;
  return menuItems(
    ...buttons.map<MenuAction>((b) => ({
      id: b.id,
      label: b.label,
      icon: b.icon,
      disabled: blockedReason(actions, b.key, b.busyLabel),
      onSelect: b.run,
    })),
    SEPARATOR,
    { id: "history", label: HISTORY_LABEL, icon: icon(IconHistory), onSelect: () => actions.showVersions(doc) },
    exportItem,
    { id: "copy-name", label: COPY_NAME_LABEL, icon: icon(IconCopy), onSelect: () => actions.copyName(doc) },
  );
}

export function DocumentRow({ doc, selected, onSelect, actions, now }: Props) {
  const lines = statusLines(doc, now);
  const all = rowButtons(doc, actions);
  const buttons = all.filter((b) => !b.menuOnly);
  const menu = useContextMenu({ label: menuLabel(doc.name), items: menuEntries(doc, all, actions) });
  return (
    <li className={`doc-row${selected ? " is-selected" : ""}`} data-testid={`doc-${doc.id}`} {...menu.triggerProps}>
      <button
        type="button"
        className="doc-pick"
        aria-current={selected ? "true" : undefined}
        data-doc-pick={doc.id}
        onClick={onSelect}
      >
        <KindIcon kind={doc.kind} />
        <span className="doc-main">
          <span className="doc-name">{doc.name}</span>
          {lines.map((line) => (
            <span key={line.kind + line.text} className={`doc-status doc-status-${line.kind}`}>
              <StatusIcon kind={line.kind} />
              {line.text}
            </span>
          ))}
        </span>
      </button>
      <div className="doc-actions">
        {buttons.map((b, i) => {
          const busy = isBusy(actions, b.key);
          const blocked = isBlocked(actions, b.key);
          const text = busy ? b.busyLabel : b.label;
          return (
            // Kunci per posisi: tombol yang sama dipakai ulang saat labelnya
            // berganti (Edit di Word menjadi Buka lagi), jadi fokus tidak hilang.
            // Nama file ikut dibacakan supaya tombol tiap baris bisa dibedakan.
            <button
              key={i}
              type="button"
              className="btn btn-ghost btn-sm"
              aria-label={`${text} ${doc.name}`}
              aria-disabled={blocked || undefined}
              aria-busy={busy || undefined}
              onClick={() => {
                if (!blocked) b.run();
              }}
            >
              {text}
            </button>
          );
        })}
        <MenuButton menu={menu} label={menuButtonLabel(doc.name)} />
      </div>
      {menu.element}
    </li>
  );
}
