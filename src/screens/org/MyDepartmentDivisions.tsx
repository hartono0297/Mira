import { IconAlertCircle, IconChevronRight, IconMessage } from "@tabler/icons-react";
import { useId, useState, type FormEvent } from "react";
import { divisionApi, type DivisionView } from "../../api/division";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { DIVISION_TEXT } from "../../i18n/org-division";
import { ChatSettingsForm } from "./MyDepartmentChatSettings";
import { validDivisionName, type DeptCtx } from "./myDepartmentShared";

export function MyDepartmentDivisions({ dept }: { dept: DeptCtx }) {
  const T = DIVISION_TEXT.divisions;
  const { ov } = dept;
  const [archiving, setArchiving] = useState<DivisionView | null>(null);
  const canCreate = ov.canManageDept && !ov.archived;
  const active = ov.divisions.filter((d) => !d.archived);
  const archived = ov.divisions.filter((d) => d.archived);

  return (
    <section className="set-section md-block" aria-labelledby="md-divisions-title">
      <div>
        <h2 id="md-divisions-title" className="set-title">
          {T.title}
        </h2>
        <p className="hint">{T.what}</p>
      </div>

      {canCreate && <CreateDivision dept={dept} />}

      {active.length === 0 ? (
        <div className="org-empty">
          <p>{canCreate ? T.emptyManage : T.emptyView}</p>
        </div>
      ) : (
        <ul className="md-div-list">
          {active.map((d) => (
            <li key={d.id}>
              <DivisionCard dept={dept} division={d} onArchive={setArchiving} />
            </li>
          ))}
        </ul>
      )}

      {archived.length > 0 && (
        <details className="org-fold">
          <summary>
            <IconChevronRight size={16} className="org-fold-chev" aria-hidden="true" />
            {T.archivedFold(archived.length)}
          </summary>
          <ul className="md-div-list">
            {archived.map((d) => (
              <li key={d.id}>
                <DivisionCard dept={dept} division={d} onArchive={setArchiving} />
              </li>
            ))}
          </ul>
        </details>
      )}

      <ConfirmDialog
        open={archiving !== null}
        onOpenChange={(open) => {
          if (!open) setArchiving(null);
        }}
        title={T.archiveTitle(archiving?.name ?? "")}
        confirmLabel={T.archiveConfirm(archiving?.name ?? "")}
        busyLabel={T.archiving}
        busy={false}
        onConfirm={() => {
          const target = archiving;
          setArchiving(null);
          if (!target) return;
          void dept.page.act(
            `md:archive:${target.id}`,
            () => divisionApi.setDivisionArchived(target.id, true),
            T.archived(target.name),
            T.archiveFail,
          );
        }}
      >
        <p>{T.archiveBody}</p>
      </ConfirmDialog>
    </section>
  );
}

function CreateDivision({ dept }: { dept: DeptCtx }) {
  const T = DIVISION_TEXT.divisions;
  const uid = useId();
  const [name, setName] = useState("");
  const [tried, setTried] = useState(false);
  const creating = dept.page.pending === "md:create";
  const invalid = tried && !validDivisionName(name);
  const off = !dept.canWrite;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setTried(true);
    if (!validDivisionName(name) || dept.busy || off) return;
    const clean = name.trim();
    const ok = await dept.page.act(
      "md:create",
      () => divisionApi.createDivision(dept.ov.teamId, clean),
      T.created(clean),
      T.createFail,
    );
    if (ok) {
      setName("");
      setTried(false);
    }
  }

  return (
    <form className="md-create" onSubmit={(e) => void submit(e)} noValidate>
      <label htmlFor={`${uid}-name`} className="md-label">
        {T.newLabel}
      </label>
      <div className="md-inline">
        <input
          id={`${uid}-name`}
          className="md-input"
          value={name}
          disabled={off}
          autoComplete="off"
          aria-invalid={invalid || undefined}
          aria-describedby={`${uid}-rule`}
          onChange={(e) => setName(e.target.value)}
        />
        <button type="submit" className="btn" disabled={off || dept.busy} aria-busy={creating || undefined}>
          {creating ? T.creating : T.create}
        </button>
      </div>
      {invalid ? (
        <p id={`${uid}-rule`} className="field-error">
          <IconAlertCircle size={16} aria-hidden="true" />
          {T.nameRule}
        </p>
      ) : (
        <p id={`${uid}-rule`} className="hint">
          {off ? DIVISION_TEXT.gate.disabled : T.nameRule}
        </p>
      )}
    </form>
  );
}

type CardProps = {
  dept: DeptCtx;
  division: DivisionView;
  onArchive: (d: DivisionView) => void;
};

function DivisionCard({ dept, division: d, onArchive }: CardProps) {
  const T = DIVISION_TEXT.divisions;
  const { page, ov, busy, canWrite } = dept;
  const uid = useId();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(d.name);
  const [tried, setTried] = useState(false);
  const [pick, setPick] = useState("");
  const manage = d.canManage && canWrite;
  const editMembers = d.canEditMembers && canWrite && !d.archived;
  const heads = d.members.filter((m) => m.role === "head");
  const plain = d.members.filter((m) => m.role !== "head");
  const people = [...heads, ...plain];
  const inDivision = new Set(d.members.map((m) => m.publicKey));
  const candidates = ov.members
    .filter((m) => !inDivision.has(m.publicKey))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
  const renameInvalid = tried && !validDivisionName(draft);
  const titleId = `${uid}-title`;

  async function rename(e: FormEvent) {
    e.preventDefault();
    setTried(true);
    const clean = draft.trim();
    if (!validDivisionName(clean) || busy) return;
    if (clean === d.name) {
      setEditing(false);
      return;
    }
    const ok = await page.act(
      `md:rename:${d.id}`,
      () => divisionApi.renameDivision(d.id, clean),
      T.renamed(d.name, clean),
      T.renameFail,
    );
    if (ok) setEditing(false);
  }

  async function add(e: FormEvent) {
    e.preventDefault();
    const target = ov.members.find((m) => m.publicKey === pick);
    if (!target || busy) return;
    const ok = await page.act(
      `md:add:${d.id}`,
      () => divisionApi.addDivisionMember(d.id, target.publicKey),
      T.added(target.displayName, d.name),
      T.addFail,
    );
    if (ok) setPick("");
  }

  function setHead(pk: string, name: string, head: boolean) {
    void page.act(
      `md:head:${d.id}:${pk}`,
      () => divisionApi.setDivisionHead(d.id, pk, head),
      head ? T.madeHead(name, d.name) : T.removedHead(name, d.name),
      head ? T.makeHeadFail : T.removeHeadFail,
    );
  }

  function remove(pk: string, name: string, self: boolean) {
    void page.act(
      `md:remove:${d.id}:${pk}`,
      () => divisionApi.removeDivisionMember(d.id, pk),
      self ? T.left(d.name) : T.removed(name, d.name),
      self ? T.leaveFail : T.removeFail,
    );
  }

  return (
    <article className={d.archived ? "md-div md-div-archived" : "md-div"} aria-labelledby={titleId}>
      <div className="md-div-head">
        {editing ? (
          <form className="md-rename" onSubmit={(e) => void rename(e)} noValidate>
            <label htmlFor={`${uid}-rename`} className="md-label">
              {T.renameLabel(d.name)}
            </label>
            <div className="md-inline">
              <input
                id={`${uid}-rename`}
                className="md-input"
                value={draft}
                autoFocus
                autoComplete="off"
                aria-invalid={renameInvalid || undefined}
                aria-describedby={`${uid}-rename-rule`}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setEditing(false);
                  }
                }}
              />
              <button
                type="submit"
                className="btn btn-sm"
                disabled={busy}
                aria-busy={page.pending === `md:rename:${d.id}` || undefined}
              >
                {page.pending === `md:rename:${d.id}` ? T.saving : T.save}
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(false)}>
                {T.cancel}
              </button>
            </div>
            <p id={`${uid}-rename-rule`} className={renameInvalid ? "field-error" : "hint"}>
              {renameInvalid && <IconAlertCircle size={16} aria-hidden="true" />}
              {T.nameRule}
            </p>
            {/* Judul kartu tetap ada untuk aria-labelledby selama nama diedit. */}
            <span id={titleId} className="sr-only">
              {d.name}
            </span>
          </form>
        ) : (
          <div className="md-div-title">
            <h3 id={titleId} className="md-div-name">
              {d.name}
            </h3>
            {d.archived && <span className="chip">{T.archivedChip}</span>}
            <span className="hint">{T.peopleCount(heads.length, plain.length)}</span>
          </div>
        )}
        {!editing && (
          <div className="row-actions">
            {dept.onOpenChat && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                aria-label={T.openChatAria(d.name)}
                onClick={() => dept.onOpenChat?.(d.conv)}
              >
                <IconMessage size={16} aria-hidden="true" />
                {T.openChat}
              </button>
            )}
            {manage && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={busy}
                aria-label={T.renameAria(d.name)}
                onClick={() => {
                  setDraft(d.name);
                  setTried(false);
                  setEditing(true);
                }}
              >
                {T.rename}
              </button>
            )}
            {manage &&
              (d.archived ? (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={busy}
                  aria-busy={page.pending === `md:archive:${d.id}` || undefined}
                  aria-label={T.restoreAria(d.name)}
                  onClick={() =>
                    void page.act(
                      `md:archive:${d.id}`,
                      () => divisionApi.setDivisionArchived(d.id, false),
                      T.restored(d.name),
                      T.restoreFail,
                    )
                  }
                >
                  {T.restore}
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={busy}
                  aria-label={T.archiveAria(d.name)}
                  onClick={() => onArchive(d)}
                >
                  {T.archive}
                </button>
              ))}
          </div>
        )}
      </div>

      {d.archived && <p className="hint">{T.archivedNote}</p>}

      {people.length === 0 ? (
        <p className="hint">{T.nobody}</p>
      ) : (
        <ul className="md-people">
          {people.map((m) => {
            const head = m.role === "head";
            const self = m.publicKey === ov.me.publicKey;
            // Kepala divisi hanya mengeluarkan anggota biasa atau dirinya sendiri; Rust memeriksa ulang.
            const canRemove = canWrite && (self || (d.canEditMembers && (d.canManage || !head)));
            const canHead = manage && !d.archived;
            return (
              <li key={m.publicKey} className="md-person">
                <span className="md-person-name">
                  {m.displayName}
                  {self && <span className="row-you"> {DIVISION_TEXT.members.you}</span>}
                </span>
                {head && <span className="chip chip-on">{T.headChip}</span>}
                {(canHead || canRemove) && (
                  <div className="row-actions">
                    {canHead && (
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        disabled={busy}
                        aria-label={
                          head ? T.removeHeadAria(m.displayName, d.name) : T.makeHeadAria(m.displayName, d.name)
                        }
                        onClick={() => setHead(m.publicKey, m.displayName, !head)}
                      >
                        {head ? T.removeHead : T.makeHead}
                      </button>
                    )}
                    {canRemove && (
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        disabled={busy}
                        aria-label={self ? T.leaveAria(d.name) : T.removeAria(m.displayName, d.name)}
                        onClick={() => remove(m.publicKey, m.displayName, self)}
                      >
                        {self ? T.leave : T.remove}
                      </button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {editMembers &&
        (candidates.length === 0 ? (
          <p className="hint">{T.addNone}</p>
        ) : (
          <form className="md-add" onSubmit={(e) => void add(e)}>
            <label htmlFor={`${uid}-add`} className="md-label">
              {T.addLabel(d.name)}
            </label>
            <div className="md-inline">
              <select
                id={`${uid}-add`}
                className="md-input md-select"
                value={pick}
                onChange={(e) => setPick(e.target.value)}
              >
                <option value="">{T.addPick}</option>
                {candidates.map((m) => (
                  <option key={m.publicKey} value={m.publicKey}>
                    {m.displayName}
                  </option>
                ))}
              </select>
              <button
                type="submit"
                className="btn btn-ghost"
                disabled={busy || pick === ""}
                aria-busy={page.pending === `md:add:${d.id}` || undefined}
              >
                {page.pending === `md:add:${d.id}` ? T.adding : T.add}
              </button>
            </div>
          </form>
        ))}

      {d.canEditMembers && (
        <details className="org-fold md-div-chat">
          <summary>
            <IconChevronRight size={16} className="org-fold-chev" aria-hidden="true" />
            {T.chatTitle}
          </summary>
          <ChatSettingsForm
            key={d.settings.setAt ?? "none"}
            dept={dept}
            name={d.name}
            divisionId={d.id}
            settings={d.settings}
            canEdit={!d.archived}
          />
        </details>
      )}
    </article>
  );
}
