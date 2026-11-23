import { IconCheck, IconSearch, IconX } from "@tabler/icons-react";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import type { PersonView } from "../../api/org";
import { initials } from "../../components/initials";
import "./people-picker.css";

export type PeoplePickerProps = {
  people: PersonView[];
  // Kunci publik yang dipilih, urut saat dipilih.
  selected: string[];
  onChange: (keys: string[]) => void;
  // Kunci yang tidak ditawarkan, misalnya saya sendiri atau anggota yang sudah ada.
  exclude?: string[];
  // Baris tetap di atas daftar, misalnya pembuat proyek.
  fixedNote?: ReactNode;
  disabled?: boolean;
  // Judul fieldset. Bawaan: "Anggota".
  label?: string;
  // Teks kalau tidak ada orang yang bisa dipilih.
  emptyText?: ReactNode;
  // Ringkasan di bawah daftar. Bawaan: "4 orang dari 3 departemen dipilih."
  summary?: (picked: PersonView[]) => ReactNode;
};

const ALL = "all";
const GUEST = "guest";
const NONE = "none";

function groupKey(p: PersonView): string {
  if (p.isGuest) return GUEST;
  return p.departmentId ? `d:${p.departmentId}` : NONE;
}

function groupName(p: PersonView): string {
  if (p.isGuest) return "Tamu";
  if (!p.departmentId) return "Belum ada departemen";
  return p.departmentName ?? "Departemen";
}

// Huruf kecil tanpa aksen, supaya "rene" menemukan "René".
function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase("id");
}

function joinParts(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  if (parts.length === 2) return `${parts[0]} dan ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, dan ${parts[parts.length - 1]}`;
}

// "4 orang dari 3 departemen", "2 orang dari 2 departemen dan 1 Tamu". Kosong kalau tidak ada yang dipilih.
export function describePicked(picked: PersonView[]): string {
  const inDept = picked.filter((p) => !p.isGuest && p.departmentId);
  const noDept = picked.filter((p) => !p.isGuest && !p.departmentId).length;
  const guests = picked.filter((p) => p.isGuest).length;
  const depts = new Set(inDept.map((p) => p.departmentId)).size;
  const parts: string[] = [];
  if (inDept.length) parts.push(`${inDept.length} orang dari ${depts} departemen`);
  if (noDept) parts.push(`${noDept} orang tanpa departemen`);
  if (guests) parts.push(`${guests} Tamu`);
  return joinParts(parts);
}

function defaultSummary(picked: PersonView[]): string {
  return picked.length ? `${describePicked(picked)} dipilih.` : "Belum ada yang dipilih.";
}

// Kunci publik selalu 64 hex, jadi tidak bentrok dengan penanda ini.
const SEARCH = "search";
const NO_KEYS: string[] = [];
// Lebih dari ini, daftar sudah mencapai tinggi maksimumnya.
const TALL_AFTER = 6;

// Pemilih orang: cari nama, saring per departemen, centang. Orang yang terpilih
// tetap terpilih walau tersembunyi oleh saringan, dan tampil di bawah daftar.
export function PeoplePicker({
  people,
  selected,
  onChange,
  exclude = NO_KEYS,
  fixedNote,
  disabled = false,
  label = "Anggota",
  emptyText = "Belum ada orang lain yang bisa dipilih.",
  summary = defaultSummary,
}: PeoplePickerProps) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState(ALL);
  const base = useId();
  const searchRef = useRef<HTMLInputElement>(null);
  const chipRefs = useRef(new Map<string, HTMLButtonElement>());
  const focusAfter = useRef<string | null>(null);

  const offered = useMemo(() => {
    const skip = new Set(exclude);
    return people
      .filter((p) => !skip.has(p.publicKey))
      .sort((a, b) => a.displayName.localeCompare(b.displayName, "id"));
  }, [people, exclude]);

  const filters = useMemo(() => {
    const depts = new Map<string, string>();
    let guests = false;
    let none = false;
    for (const p of offered) {
      const key = groupKey(p);
      if (key === GUEST) guests = true;
      else if (key === NONE) none = true;
      else depts.set(key, groupName(p));
    }
    const list = [...depts].map(([key, name]) => ({ key, name })).sort((a, b) => a.name.localeCompare(b.name, "id"));
    return [
      { key: ALL, name: "Semua" },
      ...list,
      ...(guests ? [{ key: GUEST, name: "Tamu" }] : []),
      ...(none ? [{ key: NONE, name: "Belum ada departemen" }] : []),
    ];
  }, [offered]);

  // Saringan yang tidak ada lagi (orangnya pindah atau dikeluarkan) kembali ke Semua.
  const active = filters.find((f) => f.key === filter) ?? filters[0];
  const needle = fold(query.trim());
  const visible = offered.filter(
    (p) =>
      (active.key === ALL || groupKey(p) === active.key) &&
      (!needle || fold(p.displayName).includes(needle) || fold(groupName(p)).includes(needle)),
  );

  const byKey = new Map(offered.map((p) => [p.publicKey, p]));
  const picked = selected.map((k) => byKey.get(k)).filter((p): p is PersonView => !!p);
  const isPicked = new Set(selected);

  useEffect(() => {
    const target = focusAfter.current;
    if (!target) return;
    focusAfter.current = null;
    if (target === SEARCH) searchRef.current?.focus();
    else chipRefs.current.get(target)?.focus();
  });

  function toggle(key: string, on: boolean) {
    onChange(on ? [...selected.filter((k) => k !== key), key] : selected.filter((k) => k !== key));
  }

  function unpick(key: string) {
    const at = picked.findIndex((p) => p.publicKey === key);
    const next = picked[at + 1] ?? picked[at - 1];
    focusAfter.current = next ? next.publicKey : SEARCH;
    toggle(key, false);
  }

  // Daftar panjang memakai tinggi tetap, supaya saringan dan pencarian tidak menggeser dialog.
  const tall = offered.length > TALL_AFTER ? " pp-tall" : "";
  const noMatch =
    offered.length > 0 && visible.length === 0
      ? `Tidak ada nama yang cocok dengan "${query.trim()}"${active.key === ALL ? "" : ` di ${active.name}`}.`
      : null;

  return (
    <fieldset className="pp">
      <legend className="pp-legend">{label}</legend>
      {offered.length === 0 ? (
        <p className="hint pp-empty">{emptyText}</p>
      ) : (
        <>
          <div className="pp-search">
            <IconSearch size={16} aria-hidden="true" />
            <label className="sr-only" htmlFor={`${base}-q`}>
              Cari nama atau departemen
            </label>
            <input
              ref={searchRef}
              id={`${base}-q`}
              type="search"
              autoComplete="off"
              placeholder="Cari nama atau departemen"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              // Enter di kotak cari tidak boleh mengirim form di sekitarnya.
              onKeyDown={(e) => {
                if (e.key === "Enter") e.preventDefault();
              }}
              disabled={disabled}
            />
          </div>
          <div className="pp-filters" role="group" aria-label="Saring menurut departemen">
            {filters.map((f) => (
              <button
                key={f.key}
                type="button"
                className="pp-filter"
                aria-pressed={active.key === f.key}
                onClick={() => setFilter(f.key)}
                disabled={disabled}
              >
                {f.name}
              </button>
            ))}
          </div>
        </>
      )}
      {fixedNote && (
        <div className="pp-fixed">
          <span className="pp-fixed-mark" aria-hidden="true">
            <IconCheck size={13} stroke={3} />
          </span>
          {fixedNote}
        </div>
      )}
      {visible.length > 0 && (
        <ul className={`pp-list${tall}`} aria-label="Daftar orang">
          {visible.map((p) => {
            const id = `${base}-${p.publicKey}`;
            return (
              <li key={p.publicKey}>
                <label className="pp-row">
                  <input
                    type="checkbox"
                    checked={isPicked.has(p.publicKey)}
                    onChange={(e) => toggle(p.publicKey, e.target.checked)}
                    aria-labelledby={`${id}-n`}
                    aria-describedby={`${id}-d`}
                    disabled={disabled}
                  />
                  <span className="pp-av" aria-hidden="true">
                    {initials(p.displayName)}
                  </span>
                  <span className="pp-who">
                    <span id={`${id}-n`} className="pp-name">
                      {p.displayName}
                    </span>
                    <span id={`${id}-d`} className="pp-dept">
                      {groupName(p)}
                    </span>
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
      <div aria-live="polite">{noMatch && <p className={`pp-nomatch${tall}`}>{noMatch}</p>}</div>
      <div className="pp-chosen">
        {picked.length > 0 && (
          <ul className="pp-picked" aria-label="Orang yang dipilih">
            {picked.map((p) => (
              <li key={p.publicKey}>
                <button
                  ref={(el) => {
                    if (el) chipRefs.current.set(p.publicKey, el);
                    else chipRefs.current.delete(p.publicKey);
                  }}
                  type="button"
                  className="pp-chip"
                  aria-label={`Hapus ${p.displayName} dari pilihan`}
                  onClick={() => unpick(p.publicKey)}
                  disabled={disabled}
                >
                  {p.displayName}
                  <IconX size={14} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="hint pp-summary">{summary(picked)}</p>
      </div>
    </fieldset>
  );
}
