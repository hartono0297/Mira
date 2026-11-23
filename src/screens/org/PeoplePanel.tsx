import { IconSearch } from "@tabler/icons-react";
import { useId, useMemo, useState } from "react";
import { ROLE_LABELS, TEAM_ROLE_LABELS } from "../../api";
import { orgApi, type PersonView } from "../../api/org";
import { ErrorAlert } from "../../components/ErrorAlert";
import { initials } from "../../components/initials";
import { NameWithLabels } from "../../components/NameWithLabels";
import type { OrgPage } from "./context";
import { useOrgLive } from "./useOrgLive";
import "./users.css";

// Peran yang ditulis di daftar: gabungan superadmin organisasi dan peran di departemen.
export function roleText(p: Pick<PersonView, "isGuest" | "isSuperadmin" | "departmentRole">): string {
  if (p.isGuest) return ROLE_LABELS.guest;
  if (p.isSuperadmin) return p.departmentRole === "admin" ? "Superadmin, admin departemen" : ROLE_LABELS.superadmin;
  return p.departmentRole === "admin" ? TEAM_ROLE_LABELS.admin : ROLE_LABELS.member;
}

// Pesan dari inti Rust masih bisa menyebut "tim"; di tampilan v0.3 namanya departemen.
export function orgMessage(message: string): string {
  return message.replace(/\bTim\b/g, "Departemen").replace(/\btim\b/g, "departemen");
}

export function byName<T extends { displayName: string }>(a: T, b: T): number {
  return a.displayName.localeCompare(b.displayName, "id", { sensitivity: "base" });
}

// Cocok kalau setiap kata pencarian ada di salah satu teks.
export function matches(query: string, texts: (string | null | undefined)[]): boolean {
  const words = query.toLocaleLowerCase("id").split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = texts
    .filter((t): t is string => typeof t === "string")
    .join("\n")
    .toLocaleLowerCase("id");
  return words.every((w) => hay.includes(w));
}

// Daftar orang untuk yang bukan superadmin: hanya baca, tanpa laptop atau IP.
export function PeoplePanel({ page }: { page: OrgPage }) {
  const live = useOrgLive(() => orgApi.people(), { version: page.version });
  const [query, setQuery] = useState("");
  const searchId = useId();

  const people = useMemo(() => [...(live.data ?? [])].sort(byName), [live.data]);
  const shown = people.filter((p) =>
    matches(query, [p.displayName, ...p.labels.map((l) => l.name)]),
  );
  const onlyMe = people.length === 0 || (people.length === 1 && page.isMe(people[0].publicKey));

  return (
    <section className="set-section users" aria-labelledby="people-title">
      <div className="org-head">
        <div>
          <h2 id="people-title" className="set-title">
            Anggota organisasi
          </h2>
          <p className="hint">Semua orang aktif di organisasi, dengan departemen dan perannya.</p>
        </div>
      </div>

      {live.loading && !live.data && (
        <p className="hint" role="status">
          Memuat daftar anggota...
        </p>
      )}

      {!live.loading && !live.data && (
        <div role="alert">
          <ErrorAlert title="Daftar anggota belum terbaca">
            <p>{live.error ? orgMessage(live.error.message) : "Inti Mira tidak mengirim daftar anggota."}</p>
            <button type="button" className="btn btn-ghost org-retry" onClick={() => void live.reload()}>
              Coba lagi
            </button>
          </ErrorAlert>
        </div>
      )}

      {live.data && (
        <>
          {live.error && (
            <p className="hint">
              Data terbaru belum bisa dibaca ({orgMessage(live.error.message)}). Yang tampil adalah data terakhir.
            </p>
          )}

          {onlyMe ? (
            <div className="org-empty">
              <p>
                Belum ada orang lain di organisasi ini. Rekan bisa bergabung lewat kode undangan dari admin departemen
                atau superadmin, atau lewat permintaan bergabung dari laptopnya.
              </p>
            </div>
          ) : (
            <div className="users-tools">
              <div className="field users-search">
                <label htmlFor={searchId}>Cari</label>
                <span className="users-search-box">
                  <IconSearch size={16} aria-hidden="true" />
                  <input
                    id={searchId}
                    type="search"
                    value={query}
                    placeholder="Nama atau label"
                    autoComplete="off"
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </span>
              </div>
              <p className="users-count" role="status">
                {shown.length} orang
              </p>
            </div>
          )}

          {!onlyMe && shown.length === 0 && (
            <div className="org-empty users-none">
              <p>
                <strong>Tidak ada orang yang cocok dengan "{query.trim()}"</strong>
              </p>
              <p className="hint">Pencarian memeriksa nama dan label.</p>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setQuery("")}>
                Hapus pencarian
              </button>
            </div>
          )}

          {shown.length > 0 && (
            <ul className="row-list people-list">
              {shown.map((p) => {
                const self = page.isMe(p.publicKey);
                return (
                  <li key={p.publicKey} className="row">
                    <span className="users-av" aria-hidden="true">
                      {initials(p.displayName)}
                    </span>
                    <div className="row-main">
                      <NameWithLabels
                        className="row-name"
                        name={p.displayName}
                        labels={p.labels}
                        suffix={self ? " (Anda)" : undefined}
                      />
                      <span className="row-sub">
                        {p.isGuest ? "Tamu" : (p.departmentName ?? "Belum ada departemen")}
                        {!p.isGuest && <>, {roleText(p).toLocaleLowerCase("id")}</>}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
