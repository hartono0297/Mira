import { IconAlertCircle, IconChevronRight, IconMessage } from "@tabler/icons-react";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { divisionApi, type DeptOverview, type DivisionView } from "../../api/division";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { ErrorAlert } from "../../components/ErrorAlert";
import { DIVISION_TEXT } from "../../i18n/org-division";
import { ChatSettingsForm } from "./MyDepartmentChatSettings";
import { useConfirmAction, validDivisionName, type DeptCtx } from "./myDepartmentShared";

// Ke mana fokus pindah setelah sebuah aksi, begitu data baru menunjukkan hasilnya.
// Tombol yang ditekan sering hilang bersama barisnya, jadi fokus tidak boleh jatuh ke body.
type FocusRequest = {
  target: "rename" | "heading" | "archived";
  divisionId: string;
  ready: (ov: DeptOverview) => boolean;
};

const always = () => true;

function divisionIn(ov: DeptOverview, id: string): DivisionView | undefined {
  return ov.divisions.find((d) => d.id === id);
}

export function MyDepartmentDivisions({ dept }: { dept: DeptCtx }) {
  const T = DIVISION_TEXT.divisions;
  const { ov, page } = dept;
  const [archiving, setArchiving] = useState<DivisionView | null>(null);
  const [leaving, setLeaving] = useState<DivisionView | null>(null);
  const [focus, setFocus] = useState<FocusRequest | null>(null);
  const archiveAction = useConfirmAction(page);
  const leaveAction = useConfirmAction(page);
  const renameButtons = useRef(new Map<string, HTMLButtonElement>());
  const headings = useRef(new Map<string, HTMLElement>());
  const archivedSummary = useRef<HTMLElement | null>(null);
  const canCreate = ov.canManageDept && !ov.archived;
  const active = ov.divisions.filter((d) => !d.archived);
  const archived = ov.divisions.filter((d) => d.archived);

  useEffect(() => {
    if (!focus || !focus.ready(ov)) return;
    const el =
      focus.target === "archived"
        ? archivedSummary.current
        : focus.target === "rename"
          ? renameButtons.current.get(focus.divisionId)
          : headings.current.get(focus.divisionId);
    el?.focus();
    setFocus(null);
  }, [focus, ov]);

  const register = {
    rename: (id: string) => (el: HTMLButtonElement | null) => {
      if (el) renameButtons.current.set(id, el);
      else renameButtons.current.delete(id);
    },
    heading: (id: string) => (el: HTMLElement | null) => {
      if (el) headings.current.set(id, el);
      else headings.current.delete(id);
    },
  };

  function list(items: DivisionView[]) {
    return (
      <ul className="md-div-list">
        {items.map((d) => (
          <li key={d.id}>
            <DivisionCard
              dept={dept}
              division={d}
              renameRef={register.rename(d.id)}
              headingRef={register.heading(d.id)}
              onFocus={setFocus}
              onArchive={(target) => {
                archiveAction.clear();
                setArchiving(target);
              }}
              onLeave={(target) => {
                leaveAction.clear();
                setLeaving(target);
              }}
            />
          </li>
        ))}
      </ul>
    );
  }

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
        list(active)
      )}

      {archived.length > 0 && (
        <details className="org-fold">
          <summary ref={archivedSummary}>
            <IconChevronRight size={16} className="org-fold-chev" aria-hidden="true" />
            {T.archivedFold(archived.length)}
          </summary>
          {list(archived)}
        </details>
      )}

      {archiving && (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setArchiving(null);
          }}
          title={T.archiveTitle(archiving.name)}
          confirmLabel={T.archiveConfirm(archiving.name)}
          busyLabel={T.archiving}
          busy={archiveAction.busy}
          danger={false}
          error={
            archiveAction.error && (
              <ErrorAlert title={T.archiveFail}>
                <p>{archiveAction.error.message}</p>
              </ErrorAlert>
            )
          }
          onConfirm={async () => {
            const target = archiving;
            const ok = await archiveAction.run(() => divisionApi.setDivisionArchived(target.id, true), T.archived(target.name));
            if (!ok) return;
            // Tombol Arsipkan hilang bersama kartunya: fokus pindah ke bagian Diarsipkan.
            setFocus({
              target: "archived",
              divisionId: target.id,
              ready: (next) => divisionIn(next, target.id)?.archived === true,
            });
            setArchiving(null);
          }}
        >
          <p>{T.archiveBody}</p>
        </ConfirmDialog>
      )}

      {leaving && (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setLeaving(null);
          }}
          title={T.leaveTitle(leaving.name)}
          confirmLabel={T.leaveConfirm}
          busyLabel={T.leaving}
          busy={leaveAction.busy}
          error={
            leaveAction.error && (
              <ErrorAlert title={T.leaveFail}>
                <p>{leaveAction.error.message}</p>
              </ErrorAlert>
            )
          }
          onConfirm={async () => {
            const target = leaving;
            const me = ov.me.publicKey;
            const ok = await leaveAction.run(
              () => divisionApi.removeDivisionMember(target.id, me),
              T.left(target.name),
            );
            if (!ok) return;
            setFocus({
              target: "heading",
              divisionId: target.id,
              ready: (next) => !divisionIn(next, target.id)?.members.some((m) => m.publicKey === me),
            });
            setLeaving(null);
          }}
        >
          <p>{T.leaveBody(leaving.name)}</p>
        </ConfirmDialog>
      )}
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
        <button
          type="submit"
          className="btn"
          disabled={off || dept.busy}
          aria-busy={creating || undefined}
          aria-describedby={`${uid}-rule`}
        >
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
          {dept.gateHint ?? T.nameRule}
        </p>
      )}
    </form>
  );
}

type CardProps = {
  dept: DeptCtx;
  division: DivisionView;
  renameRef: (el: HTMLButtonElement | null) => void;
  headingRef: (el: HTMLElement | null) => void;
  onFocus: (request: FocusRequest) => void;
  onArchive: (d: DivisionView) => void;
  onLeave: (d: DivisionView) => void;
};

function DivisionCard({ dept, division: d, renameRef, headingRef, onFocus, onArchive, onLeave }: CardProps) {
  const T = DIVISION_TEXT.divisions;
  const { page, ov, busy, canWrite, gateHint } = dept;
  const uid = useId();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(d.name);
  const [tried, setTried] = useState(false);
  const [pick, setPick] = useState("");
  // Departemen yang diarsipkan hanya dibaca: tombolnya tidak ditampilkan. Gerbang versi yang
  // tertutup hanya menonaktifkan tombol, dengan penjelasan di kartu.
  const live = !ov.archived;
  const off = !canWrite;
  const manage = d.canManage && live;
  const editMembers = d.canEditMembers && live && !d.archived;
  const heads = d.members.filter((m) => m.role === "head");
  const plain = d.members.filter((m) => m.role !== "head");
  const people = [...heads, ...plain];
  const inDivision = new Set(d.members.map((m) => m.publicKey));
  const candidates = ov.members
    .filter((m) => !inDivision.has(m.publicKey))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
  const renameInvalid = tried && !validDivisionName(draft);
  const titleId = `${uid}-title`;
  const gateId = `${uid}-gate`;
  const gateDesc = off && gateHint ? gateId : undefined;

  function rowActions(publicKey: string, head: boolean) {
    const self = publicKey === ov.me.publicKey;
    // Kepala divisi hanya mengeluarkan anggota biasa atau dirinya sendiri; Rust memeriksa ulang.
    const canRemove = live && (self || (d.canEditMembers && (d.canManage || !head)));
    const canHead = manage && !d.archived;
    return { self, canRemove, canHead };
  }
  const anyAction =
    manage ||
    editMembers ||
    people.some((m) => {
      const a = rowActions(m.publicKey, m.role === "head");
      return a.canHead || a.canRemove;
    });

  function closeEdit() {
    setEditing(false);
    onFocus({ target: "rename", divisionId: d.id, ready: always });
  }

  async function rename(e: FormEvent) {
    e.preventDefault();
    setTried(true);
    const clean = draft.trim();
    if (!validDivisionName(clean) || busy) return;
    if (clean === d.name) {
      closeEdit();
      return;
    }
    const ok = await page.act(
      `md:rename:${d.id}`,
      () => divisionApi.renameDivision(d.id, clean),
      T.renamed(d.name, clean),
      T.renameFail,
    );
    if (ok) closeEdit();
  }

  async function restore() {
    const ok = await page.act(
      `md:archive:${d.id}`,
      () => divisionApi.setDivisionArchived(d.id, false),
      T.restored(d.name),
      T.restoreFail,
    );
    // Tombol Pulihkan hilang bersama kartunya: fokus pindah ke kartu yang dipulihkan.
    if (ok) {
      onFocus({
        target: "rename",
        divisionId: d.id,
        ready: (next) => divisionIn(next, d.id)?.archived === false,
      });
    }
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

  async function setHead(pk: string, name: string, head: boolean) {
    const ok = await page.act(
      `md:head:${d.id}:${pk}`,
      () => divisionApi.setDivisionHead(d.id, pk, head),
      head ? T.madeHead(name, d.name) : T.removedHead(name, d.name),
      head ? T.makeHeadFail : T.removeHeadFail,
    );
    // Baris yang dijadikan anggota pindah ke bawah kepala; fokus ke judul kartu supaya tidak hilang.
    if (ok && !head) {
      onFocus({
        target: "heading",
        divisionId: d.id,
        ready: (next) => divisionIn(next, d.id)?.members.find((m) => m.publicKey === pk)?.role !== "head",
      });
    }
  }

  async function remove(pk: string, name: string) {
    const ok = await page.act(
      `md:remove:${d.id}:${pk}`,
      () => divisionApi.removeDivisionMember(d.id, pk),
      T.removed(name, d.name),
      T.removeFail,
    );
    if (ok) {
      onFocus({
        target: "heading",
        divisionId: d.id,
        ready: (next) => !divisionIn(next, d.id)?.members.some((m) => m.publicKey === pk),
      });
    }
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
                    closeEdit();
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
              <button type="button" className="btn btn-ghost btn-sm" onClick={closeEdit}>
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
            <h3 id={titleId} ref={headingRef} className="md-div-name" tabIndex={-1}>
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
                ref={renameRef}
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={busy || off}
                aria-label={T.renameAria(d.name)}
                aria-describedby={gateDesc}
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
                  disabled={busy || off}
                  aria-busy={page.pending === `md:archive:${d.id}` || undefined}
                  aria-label={T.restoreAria(d.name)}
                  aria-describedby={gateDesc}
                  onClick={() => void restore()}
                >
                  {T.restore}
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={busy || off}
                  aria-label={T.archiveAria(d.name)}
                  aria-describedby={gateDesc}
                  onClick={() => onArchive(d)}
                >
                  {T.archive}
                </button>
              ))}
          </div>
        )}
      </div>

      {d.archived && <p className="hint">{T.archivedNote}</p>}
      {gateDesc && anyAction && (
        <p id={gateId} className="hint">
          {gateHint}
        </p>
      )}

      {people.length === 0 ? (
        <p className="hint">{T.nobody}</p>
      ) : (
        <ul className="md-people">
          {people.map((m) => {
            const head = m.role === "head";
            const { self, canRemove, canHead } = rowActions(m.publicKey, head);
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
                        disabled={busy || off}
                        aria-busy={page.pending === `md:head:${d.id}:${m.publicKey}` || undefined}
                        aria-label={
                          head ? T.makeMemberAria(m.displayName, d.name) : T.makeHeadAria(m.displayName, d.name)
                        }
                        aria-describedby={gateDesc}
                        onClick={() => void setHead(m.publicKey, m.displayName, !head)}
                      >
                        {head ? T.makeMember : T.makeHead}
                      </button>
                    )}
                    {canRemove && (
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        disabled={busy || off}
                        aria-busy={page.pending === `md:remove:${d.id}:${m.publicKey}` || undefined}
                        aria-label={self ? T.leaveAria(d.name) : T.removeAria(m.displayName, d.name)}
                        aria-describedby={gateDesc}
                        onClick={() => (self ? onLeave(d) : void remove(m.publicKey, m.displayName))}
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
                disabled={off}
                aria-describedby={gateDesc}
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
                disabled={busy || off || pick === ""}
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
            dept={dept}
            name={d.name}
            divisionId={d.id}
            settings={d.settings}
            canEdit={!d.archived && live}
          />
        </details>
      )}
    </article>
  );
}
