import { IconAlertTriangle, IconLock } from "@tabler/icons-react";
import type { DocumentSummary } from "../../api/documents";
import { keys, type DocActions } from "./actions";
import { KindIcon } from "./KindIcon";
import { appName, editable, statusLines, type StatusKind } from "./text";

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
  return null;
}

type Btn = { key: string; label: string; busyLabel: string; primary?: boolean; run: () => void };

// Tombol di baris mengikuti keadaan file: bentrok, diedit di laptop ini,
// diedit rekan, atau biasa.
function rowButtons(doc: DocumentSummary, actions: DocActions): Btn[] {
  const mine = doc.editing.find((e) => e.local);
  const rekan = doc.editing.find((e) => !e.local);
  const app = appName(doc.kind);
  if (mine) {
    return [
      { key: keys.edit(doc.id, null), label: "Buka lagi", busyLabel: "Membuka...", run: () => actions.edit(doc, null) },
      {
        key: keys.finish(doc.id),
        label: "Selesai mengedit",
        busyLabel: "Menyelesaikan...",
        run: () => actions.finish(doc),
      },
    ];
  }
  if (doc.conflict && doc.conflictVersions.length > 1) {
    return [{ key: `conflict:${doc.id}`, label: "Selesaikan bentrok", busyLabel: "", run: () => actions.showConflict(doc) }];
  }
  if (rekan || !editable(doc.kind) || !doc.can.edit) {
    const label = rekan || editable(doc.kind) ? "Buka hanya baca" : "Buka";
    return [{ key: keys.open(doc.id, null), label, busyLabel: "Membuka...", run: () => actions.open(doc, null) }];
  }
  return [{ key: keys.edit(doc.id, null), label: `Edit di ${app}`, busyLabel: "Membuka...", run: () => actions.edit(doc, null) }];
}

export function DocumentRow({ doc, selected, onSelect, actions, now }: Props) {
  const nameId = `doc-name-${doc.id}`;
  const lines = statusLines(doc, now);
  const buttons = rowButtons(doc, actions);
  return (
    <li className={`doc-row${selected ? " is-selected" : ""}`} data-testid={`doc-${doc.id}`}>
      <button type="button" className="doc-pick" aria-current={selected ? "true" : undefined} onClick={onSelect}>
        <KindIcon kind={doc.kind} />
        <span className="doc-main">
          <span className="doc-name" id={nameId}>
            {doc.name}
          </span>
          {lines.map((line) => (
            <span key={line.kind + line.text} className={`doc-status doc-status-${line.kind}`}>
              <StatusIcon kind={line.kind} />
              {line.text}
            </span>
          ))}
        </span>
      </button>
      <div className="doc-actions">
        {buttons.map((b) => {
          const busy = actions.pending === b.key;
          return (
            <button
              key={b.key + b.label}
              type="button"
              className="btn btn-ghost btn-sm"
              aria-describedby={nameId}
              disabled={busy}
              aria-busy={busy || undefined}
              onClick={b.run}
            >
              {busy ? b.busyLabel : b.label}
            </button>
          );
        })}
      </div>
    </li>
  );
}
