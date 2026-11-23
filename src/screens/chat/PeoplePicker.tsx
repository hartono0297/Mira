import { IconSearch, IconX } from "@tabler/icons-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { Person } from "../../api/chat";
import { orgApi } from "../../api/org";
import { initials } from "../../components/initials";
import { PersonName } from "./PersonName";

// Departemen per kunci publik, dari orgApi.people(). Peta kosong selama memuat atau kalau
// gagal: pemilih dan daftar anggota tetap jalan, hanya tanpa chip dan baris departemen.
export function usePeopleDirectory(enabled: boolean): Map<string, string> {
  const [departments, setDepartments] = useState<Map<string, string>>(() => new Map());
  useEffect(() => {
    if (!enabled) return;
    let stale = false;
    orgApi
      .people()
      .then((people) => {
        if (stale) return;
        const map = new Map<string, string>();
        for (const p of people) if (p.departmentName) map.set(p.publicKey, p.departmentName);
        setDepartments(map);
      })
      .catch(() => {
        // Tanpa data departemen pun pemilih tetap bisa dipakai.
      });
    return () => {
      stale = true;
    };
  }, [enabled]);
  return departments;
}

type Props = {
  people: Person[];
  departments: Map<string, string>;
  selected: string[];
  onChange: (keys: string[]) => void;
  disabled?: boolean;
  // Petunjuk di bawah chip orang terpilih (jumlah dan aturan).
  hint: ReactNode;
  // Teks kalau tidak ada orang yang bisa dipilih sama sekali.
  emptyText: string;
};

const ALL = "";

// Cari nama, saring per departemen, centang orang. Orang terpilih tampil sebagai chip
// di bawah daftar dan tetap terlihat walau saringan diganti.
export function PeoplePicker({ people, departments, selected, onChange, disabled, hint, emptyText }: Props) {
  const [query, setQuery] = useState("");
  const [dept, setDept] = useState(ALL);
  const ids = useId();
  const searchRef = useRef<HTMLInputElement>(null);
  const chipsRef = useRef<HTMLUListElement>(null);

  const sorted = [...people].sort((a, b) => a.name.localeCompare(b.name, "id"));
  const deptNames = [...new Set(sorted.map((p) => departments.get(p.publicKey)).filter((d): d is string => !!d))].sort(
    (a, b) => a.localeCompare(b, "id"),
  );
  // Departemen yang dipilih bisa hilang kalau data berubah: kembali ke Semua.
  const activeDept = deptNames.includes(dept) ? dept : ALL;

  const q = query.trim().toLowerCase();
  const shown = sorted.filter((p) =>
    q ? p.name.toLowerCase().includes(q) : activeDept === ALL || departments.get(p.publicKey) === activeDept,
  );
  const chosen = sorted.filter((p) => selected.includes(p.publicKey));

  function toggle(key: string, on: boolean) {
    onChange(on ? [...selected.filter((k) => k !== key), key] : selected.filter((k) => k !== key));
  }

  function removeChip(key: string, index: number) {
    toggle(key, false);
    // Fokus pindah ke chip berikutnya (atau sebelumnya), atau ke kolom cari kalau habis.
    requestAnimationFrame(() => {
      const buttons = chipsRef.current?.querySelectorAll<HTMLButtonElement>("button");
      const next = buttons?.[Math.min(index, (buttons?.length ?? 1) - 1)];
      if (next) next.focus();
      else searchRef.current?.focus();
    });
  }

  if (people.length === 0) {
    return <p className="pick-note">{emptyText}</p>;
  }

  let emptyFilter: string | null = null;
  if (shown.length === 0) {
    emptyFilter = q ? `Tidak ada rekan bernama "${query.trim()}".` : "Tidak ada rekan di departemen ini.";
  }

  return (
    <div className="pick">
      <div className="field">
        <label htmlFor={`${ids}-search`}>Pilih orang</label>
        <div className="pick-search">
          <IconSearch size={16} aria-hidden="true" />
          <input
            ref={searchRef}
            id={`${ids}-search`}
            type="search"
            autoComplete="off"
            placeholder="Cari nama"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              // Cari selalu di semua departemen.
              if (e.target.value.trim()) setDept(ALL);
            }}
            aria-describedby={`${ids}-count`}
            disabled={disabled}
          />
        </div>
        <p id={`${ids}-count`} className="sr-only" aria-live="polite">
          {shown.length} rekan ditampilkan
        </p>
      </div>

      {deptNames.length > 0 && (
        <div className="pick-depts" role="group" aria-label="Saring menurut departemen">
          {[ALL, ...deptNames].map((name) => (
            <button
              key={name || "semua"}
              type="button"
              className="pick-dept"
              aria-pressed={activeDept === name && !q}
              onClick={() => {
                setDept(name);
                setQuery("");
              }}
              disabled={disabled}
            >
              {name || "Semua"}
            </button>
          ))}
        </div>
      )}

      {emptyFilter ? (
        <p className="pick-note">{emptyFilter}</p>
      ) : (
        <ul className="pick-list" aria-label="Rekan">
          {shown.map((p) => {
            const department = departments.get(p.publicKey);
            const checked = selected.includes(p.publicKey);
            return (
              <li key={p.publicKey}>
                <label className="pick-row">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(e) => toggle(p.publicKey, e.target.checked)}
                    disabled={disabled}
                  />
                  <span className="pick-av" aria-hidden="true">
                    {initials(p.name)}
                  </span>
                  <span className="pick-who">
                    <span className="pick-name">
                      <PersonName person={p} />
                    </span>
                    {department && <span className="pick-dept-line">{department}</span>}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}

      {chosen.length > 0 && (
        <ul ref={chipsRef} className="pick-chips" aria-label="Orang yang dipilih">
          {chosen.map((p, i) => (
            <li key={p.publicKey} className="pick-chip">
              <PersonName person={p} />
              <button
                type="button"
                className="pick-chip-x"
                aria-label={`Hapus ${p.name} dari pilihan`}
                onClick={() => removeChip(p.publicKey, i)}
                disabled={disabled}
              >
                <IconX size={14} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <p className="hint" aria-live="polite">
        {hint}
      </p>
    </div>
  );
}
