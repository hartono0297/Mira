import { IconLoader2, IconMessage } from "@tabler/icons-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ROLE_LABELS, toAppError, type AppError } from "../../api";
import type { Person } from "../../api/chat";
import { orgApi, subscribeOrg, type PersonView } from "../../api/org";
import { Dialog, DialogClose } from "../../components/Dialog";
import { ErrorAlert } from "../../components/ErrorAlert";
import { initials } from "../../components/initials";
import { NameWithLabels } from "../../components/NameWithLabels";
import { PROFILE } from "../../i18n/chat-dialogs";
import { deptWithDivisions } from "../org/divisionText";
import { useChatActions } from "./ChatActions";
import "./profile.css";

// Teks dialog profil (kamus src/i18n/chat-profile.*). Teks menu orang ada di menuText.ts.
export { PROFILE };

// Peran di organisasi, dengan nama yang sama seperti layar Organisasi (ROLE_LABELS).
// Admin departemen ditulis di baris Departemen.
function orgRole(p: PersonView): string {
  if (p.isGuest) return ROLE_LABELS.guest;
  if (p.isSuperadmin) return ROLE_LABELS.superadmin;
  return ROLE_LABELS.member;
}

type Load = { status: "loading" } | { status: "error"; error: AppError } | { status: "ready"; person: PersonView | null };

// Data orang dari orgApi.people(), dimuat saat dialog dibuka dan saat data organisasi
// berubah. Memuat ulang di latar tidak menghapus data yang sedang tampil.
function useOrgPerson(publicKey: string | null) {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [retrying, setRetrying] = useState(false);
  const seq = useRef(0);

  const loadPeople = useCallback(
    async (quiet: boolean) => {
      if (!publicKey) return;
      const n = ++seq.current;
      if (!quiet) setLoad({ status: "loading" });
      try {
        const people = await orgApi.people();
        if (n === seq.current) setLoad({ status: "ready", person: people.find((p) => p.publicKey === publicKey) ?? null });
      } catch (err) {
        // Gagal saat memuat ulang di latar: data lama tetap tampil.
        if (n === seq.current) setLoad((cur) => (quiet && cur.status === "ready" ? cur : { status: "error", error: toAppError(err) }));
      }
    },
    [publicKey],
  );

  useEffect(() => {
    if (!publicKey) return;
    void loadPeople(false);
    const stop = subscribeOrg(() => void loadPeople(true));
    return () => {
      seq.current++;
      stop();
    };
  }, [publicKey, loadPeople]);

  const retry = useCallback(async () => {
    setRetrying(true);
    try {
      await loadPeople(true);
    } finally {
      setRetrying(false);
    }
  }, [loadPeople]);

  return { load, retry, retrying };
}

export type ProfileDialogProps = {
  // null: dialog tertutup.
  person: Person | null;
  onOpenChange: (open: boolean) => void;
};

// Profil singkat seseorang: nama dan label, peran, departemen, sidik jari kunci.
// Hanya data dari organisasi (orgApi.people()); tidak ada foto, email, atau telepon.
export function ProfileDialog({ person, onOpenChange }: ProfileDialogProps) {
  return (
    <Dialog open={person !== null} onOpenChange={onOpenChange} title={person ? PROFILE.title(person.name) : ""}>
      {person && <ProfileBody key={person.publicKey} person={person} onOpenChange={onOpenChange} />}
    </Dialog>
  );
}

function ProfileBody({ person, onOpenChange }: { person: Person; onOpenChange: (open: boolean) => void }) {
  const chat = useChatActions();
  const { load, retry, retrying } = useOrgPerson(person.publicKey);
  const [opening, setOpening] = useState(false);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );

  const isMe = chat?.me === person.publicKey;
  const canDm = !!chat && !isMe && chat.canMessage(person.publicKey);

  async function sendDm() {
    if (!chat || opening) return;
    setOpening(true);
    try {
      await chat.openDm(person);
    } finally {
      if (alive.current) setOpening(false);
    }
    // Berhasil: ChatScreen sudah menutup dialog dan pindah ke chat pribadi. Gagal: error
    // tampil di layar chat, jadi dialog ditutup supaya pesannya terlihat.
    onOpenChange(false);
  }

  let content;
  if (load.status === "loading") {
    content = (
      <p className="prof-state" role="status">
        <IconLoader2 size={16} className="prof-spin" aria-hidden="true" />
        {PROFILE.loading}
      </p>
    );
  } else if (load.status === "error") {
    content = (
      <ErrorAlert title={PROFILE.loadFailed}>
        <p>{load.error.message}</p>
        <button
          type="button"
          className="btn btn-ghost btn-sm prof-retry"
          onClick={() => void retry()}
          disabled={retrying}
          aria-busy={retrying || undefined}
        >
          {retrying ? PROFILE.retrying : PROFILE.retry}
        </button>
      </ErrorAlert>
    );
  } else if (!load.person) {
    content = (
      <>
        <ProfileHead name={person.name} isMe={isMe} />
        <p className="prof-state">{PROFILE.notFound(person.name)}</p>
      </>
    );
  } else {
    const p = load.person;
    content = (
      <>
        <ProfileHead name={p.displayName} isMe={isMe} labels={p.labels} />
        <dl className="prof-facts">
          <div>
            <dt>{PROFILE.role}</dt>
            <dd>{orgRole(p)}</dd>
          </div>
          {!p.isGuest && (
            <div>
              <dt>{PROFILE.department}</dt>
              <dd>
                {deptWithDivisions(p.departmentName, p.divisions) ?? PROFILE.noDepartment}
                {p.departmentName && p.departmentRole === "admin" && `, ${PROFILE.deptAdmin}`}
              </dd>
            </div>
          )}
          <div>
            <dt>{PROFILE.fingerprint}</dt>
            <dd>
              <span className="mono prof-fp">{p.fingerprint}</span>
              <span className="prof-note">{isMe ? PROFILE.fingerprintNoteMe : PROFILE.fingerprintNote(p.displayName)}</span>
            </dd>
          </div>
        </dl>
      </>
    );
  }

  return (
    <>
      {/* Error dibacakan begitu muncul (ErrorAlert butuh wilayah aria-live dari pemanggil). */}
      <div aria-live="polite" className="prof-body">
        {content}
      </div>
      <div className="dlg-actions">
        <DialogClose asChild>
          <button type="button" className="btn btn-ghost">
            {PROFILE.close}
          </button>
        </DialogClose>
        {canDm && (
          <button type="button" className="btn" onClick={() => void sendDm()} disabled={opening} aria-busy={opening || undefined}>
            <IconMessage size={16} aria-hidden="true" />
            {opening ? PROFILE.opening : PROFILE.sendDm}
          </button>
        )}
      </div>
    </>
  );
}

function ProfileHead({ name, isMe, labels = [] }: { name: string; isMe: boolean; labels?: PersonView["labels"] }) {
  return (
    <div className="prof-head">
      <span className="prof-av" aria-hidden="true">
        {initials(name)}
      </span>
      {/* Semua label tampil di profil; di daftar lain dibatasi tiga. */}
      <NameWithLabels className="prof-name" name={name} labels={labels} max={labels.length} suffix={isMe ? PROFILE.me : undefined} />
    </div>
  );
}
