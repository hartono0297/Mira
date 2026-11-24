import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import type { LabelRef, PersonView } from "../api/org";
import { COMPONENTS_TEXT } from "../i18n/components";
import { NameWithLabels } from "./NameWithLabels";
import "./people-picker.css";

export type PeoplePickerProps = {
  // Orang yang bisa dipilih, biasanya hasil orgApi.people().
  people: readonly PersonView[];
  // Kunci publik yang sedang dicentang. Pemanggil yang menyimpan state-nya.
  selected: ReadonlySet<string>;
  onToggle: (publicKey: string, checked: boolean) => void;
  // Nama daftar untuk pembaca layar, misalnya "Orang untuk label Drafter".
  listLabel: string;
  // Label di samping nama. Bawaan: semua label orang itu.
  labelsOf?: (person: PersonView) => readonly LabelRef[];
  // Catatan kecil di bawah departemen, dibacakan sebagai keterangan kotak centang.
  renderNote?: (person: PersonView) => ReactNode;
  // Menambahkan " (Anda)" di samping nama sendiri.
  isMe?: (publicKey: string) => boolean;
  // Teks sesudah "N orang dipilih", misalnya ", 2 perubahan belum disimpan".
  summaryExtra?: ReactNode;
  disabled?: boolean;
  // Fokus ke kolom pencarian saat dipasang (misalnya setelah isi dialog berganti).
  autoFocusSearch?: boolean;
  idPrefix?: string;
};

const collator = new Intl.Collator("id", { sensitivity: "base" });

function deptKey(p: PersonView): string {
  if (p.isGuest) return "guest";
  return p.departmentName ? `dept:${p.departmentName}` : "none";
}

const T = COMPONENTS_TEXT.people;

function deptText(p: PersonView): string {
  if (p.isGuest) return T.guest;
  return p.departmentName ?? T.noDept;
}

function deptLabel(key: string): string {
  if (key === "guest") return T.guest;
  if (key === "none") return T.noDept;
  return key.slice("dept:".length);
}

// Daftar centang orang dengan pencarian nama dan saringan departemen (termasuk
// "Tamu" dan "Belum ada departemen"), urut nama, dengan label di samping nama.
// Taruh di dalam dialog; daftar bergulir sendiri kalau orangnya banyak. Contoh:
//   const [picked, setPicked] = useState(new Set<string>());
//   <PeoplePicker people={people} selected={picked} listLabel="Penanggung jawab"
//     onToggle={(pk, on) => setPicked((s) => { const n = new Set(s); if (on) n.add(pk); else n.delete(pk); return n; })} />
export function PeoplePicker({
  people,
  selected,
  onToggle,
  listLabel,
  labelsOf = (p) => p.labels,
  renderNote,
  isMe,
  summaryExtra,
  disabled = false,
  autoFocusSearch = false,
  idPrefix,
}: PeoplePickerProps) {
  const autoId = useId();
  const uid = idPrefix ?? autoId;
  const [query, setQuery] = useState("");
  const [dept, setDept] = useState("all");
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (autoFocusSearch) searchRef.current?.focus();
  }, [autoFocusSearch]);

  const sorted = useMemo(() => [...people].sort((a, b) => collator.compare(a.displayName, b.displayName)), [people]);
  const deptNames = useMemo(
    () =>
      [...new Set(people.filter((p) => !p.isGuest && p.departmentName).map((p) => p.departmentName as string))].sort(
        collator.compare,
      ),
    [people],
  );
  const hasGuest = people.some((p) => p.isGuest);
  const hasNone = people.some((p) => !p.isGuest && !p.departmentName);

  // Saringan yang sudah tidak ada pilihannya (data dimuat ulang) kembali ke semua.
  const deptValid =
    dept === "all" ||
    (dept === "guest" && hasGuest) ||
    (dept === "none" && hasNone) ||
    deptNames.includes(deptLabel(dept));
  const activeDept = deptValid ? dept : "all";

  const q = query.trim().toLocaleLowerCase("id");
  const shown = sorted.filter(
    (p) => (activeDept === "all" || deptKey(p) === activeDept) && (!q || p.displayName.toLocaleLowerCase("id").includes(q)),
  );

  const filterText = [
    q ? T.filterName(query.trim()) : null,
    activeDept !== "all" ? T.filterDept(deptLabel(activeDept)) : null,
  ]
    .filter(Boolean)
    .join(T.filterJoin);

  const resetFilters = () => {
    setQuery("");
    setDept("all");
    searchRef.current?.focus();
  };

  return (
    <div className="ppick">
      <div className="ppick-filters">
        <div className="field">
          <label htmlFor={`${uid}-q`}>{T.search}</label>
          <input
            id={`${uid}-q`}
            ref={searchRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoComplete="off"
          />
        </div>
        <div className="field">
          <label htmlFor={`${uid}-d`}>{T.dept}</label>
          <select id={`${uid}-d`} value={activeDept} onChange={(e) => setDept(e.target.value)}>
            <option value="all">{T.allDepts}</option>
            {deptNames.map((name) => (
              <option key={name} value={`dept:${name}`}>
                {name}
              </option>
            ))}
            {hasGuest && <option value="guest">{T.guest}</option>}
            {hasNone && <option value="none">{T.noDept}</option>}
          </select>
        </div>
      </div>

      <p className="hint ppick-count">
        {T.selected(selected.size)}
        {summaryExtra}
      </p>

      {people.length === 0 ? (
        <div className="ppick-empty">
          <p>{T.empty}</p>
        </div>
      ) : shown.length === 0 ? (
        <div className="ppick-empty">
          <p>{T.noMatch(filterText)}</p>
          <button type="button" className="btn btn-ghost btn-sm" onClick={resetFilters}>
            {T.showAll}
          </button>
        </div>
      ) : (
        <ul className="ppick-list" aria-label={listLabel}>
          {shown.map((p, i) => {
            const nameId = `${uid}-n${i}`;
            const subId = `${uid}-s${i}`;
            const noteId = `${uid}-t${i}`;
            const note = renderNote?.(p);
            const hasNote = note !== undefined && note !== null && note !== false;
            return (
              <li key={p.publicKey}>
                <label className="ppick-row">
                  <input
                    type="checkbox"
                    checked={selected.has(p.publicKey)}
                    onChange={(e) => onToggle(p.publicKey, e.target.checked)}
                    disabled={disabled}
                    aria-labelledby={nameId}
                    aria-describedby={hasNote ? `${subId} ${noteId}` : subId}
                  />
                  <span className="ppick-text">
                    <span id={nameId}>
                      <NameWithLabels
                        name={p.displayName}
                        labels={labelsOf(p)}
                        suffix={isMe?.(p.publicKey) ? T.me : undefined}
                      />
                    </span>
                    <span id={subId} className="ppick-sub">
                      {deptText(p)}
                    </span>
                    {hasNote && (
                      <span id={noteId} className="ppick-note">
                        {note}
                      </span>
                    )}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
