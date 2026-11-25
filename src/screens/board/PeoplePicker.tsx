import { IconCheck, IconSearch, IconX } from "@tabler/icons-react";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import type { PersonView } from "../../api/org";
import { Avatar } from "../../components/Avatar";
import { NameWithLabels } from "../../components/NameWithLabels";
import { BOARD_DETAIL } from "../../i18n/board-detail";
import { useLang } from "../../i18n/core";
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

// Teks pemilih, dibaca setiap kali dipakai supaya mengikuti bahasa aktif.
const T = () => BOARD_DETAIL.picker;

const ALL = "all";
const GUEST = "guest";
const NONE = "none";

function groupKey(p: PersonView): string {
  if (p.isGuest) return GUEST;
  return p.departmentId ? `d:${p.departmentId}` : NONE;
}

function groupName(p: PersonView): string {
  if (p.isGuest) return T().guest;
  if (!p.departmentId) return T().noDept;
  return p.departmentName ?? T().deptFallback;
}

// Huruf kecil tanpa aksen, supaya "rene" menemukan "René".
function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase("id");
}

function joinParts(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  if (parts.length === 2) return T().joinTwo(parts[0], parts[1]);
  return T().joinMany(parts.slice(0, -1).join(", "), parts[parts.length - 1]);
}

// "4 orang dari 3 departemen", "2 orang dari 2 departemen dan 1 Tamu". Kosong kalau tidak ada yang dipilih.
export function describePicked(picked: PersonView[]): string {
  const inDept = picked.filter((p) => !p.isGuest && p.departmentId);
  const noDept = picked.filter((p) => !p.isGuest && !p.departmentId).length;
  const guests = picked.filter((p) => p.isGuest).length;
  const depts = new Set(inDept.map((p) => p.departmentId)).size;
  const parts: string[] = [];
  if (inDept.length) parts.push(T().inDept(inDept.length, depts));
  if (noDept) parts.push(T().withoutDept(noDept));
  if (guests) parts.push(T().guests(guests));
  return joinParts(parts);
}

function defaultSummary(picked: PersonView[]): string {
  return picked.length ? T().picked(describePicked(picked)) : T().noneSelected;
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
  label = T().label,
  emptyText = T().empty,
  summary = defaultSummary,
}: PeoplePickerProps) {
  const lang = useLang();
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
      { key: ALL, name: T().all },
      ...list,
      ...(guests ? [{ key: GUEST, name: T().guest }] : []),
      ...(none ? [{ key: NONE, name: T().noDept }] : []),
    ];
    // lang: nama saringan ikut bahasa aktif.
  }, [offered, lang]);

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
      ? active.key === ALL
        ? T().noMatch(query.trim())
        : T().noMatchIn(query.trim(), active.name)
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
              {T().search}
            </label>
            <input
              ref={searchRef}
              id={`${base}-q`}
              type="search"
              autoComplete="off"
              placeholder={T().search}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              // Enter di kotak cari tidak boleh mengirim form di sekitarnya.
              onKeyDown={(e) => {
                if (e.key === "Enter") e.preventDefault();
              }}
              disabled={disabled}
            />
          </div>
          <div className="pp-filters" role="group" aria-label={T().filterLabel}>
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
        <ul className={`pp-list${tall}`} aria-label={T().listLabel}>
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
                  <Avatar className="pp-av" name={p.displayName} publicKey={p.publicKey} />
                  <span className="pp-who">
                    <span id={`${id}-n`} className="pp-name">
                      <NameWithLabels name={p.displayName} labels={p.labels ?? []} />
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
          <ul className="pp-picked" aria-label={T().pickedLabel}>
            {picked.map((p) => (
              <li key={p.publicKey}>
                <button
                  ref={(el) => {
                    if (el) chipRefs.current.set(p.publicKey, el);
                    else chipRefs.current.delete(p.publicKey);
                  }}
                  type="button"
                  className="pp-chip"
                  aria-label={T().unpick(p.displayName)}
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
        {/* Tanpa orang yang bisa dipilih, emptyText di atas sudah menjelaskan. */}
        {offered.length > 0 && <p className="hint pp-summary">{summary(picked)}</p>}
      </div>
    </fieldset>
  );
}
