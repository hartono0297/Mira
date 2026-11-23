import { IconLayoutKanban, IconListCheck, IconPencil, IconPlus, IconUsers } from "@tabler/icons-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { boardApi, subscribeBoard, type ProjectSummary } from "../../api/board";
import { ErrorAlert } from "../../components/ErrorAlert";
import { SidebarCount } from "../../components/SidebarCount";
import { useCreateOptions } from "./createOptions";
import { dueSummary, type DueSummary } from "./dueCounts";
import { todayIso } from "./format";
import { MyTasks } from "./MyTasks";
import { NewProjectDialog } from "./NewProjectDialog";
import { OutsideProjects } from "./OutsideProjects";
import { ProjectBoard, type ProjectBoardHandle } from "./ProjectBoard";
import { TaskDetail } from "./TaskDetail";
import { TEKS_MENU } from "./teksMenu";
import { boardMenuItems, useBoardMenu } from "./useBoardMenu";
import { useBoardLive } from "./useBoardLive";
import "./board.css";
import "./members.css";

// Pilihan terakhir di sub-menu Board, per laptop.
export const BOARD_SELECTION_KEY = "mira.board.selection";
export const MY_TASKS = "__mine__";
// Angka tenggat dihitung ulang tiap menit juga, supaya pergantian hari ikut terhitung.
export const DUE_POLL_MS = 60000;
export const CREATE_NOTE = "Proyek dibuat oleh superadmin atau admin departemen.";
const DUE_MEANING = "task tenggat hari ini atau lewat";

function readSelection(): string | null {
  try {
    return window.localStorage.getItem(BOARD_SELECTION_KEY);
  } catch {
    return null;
  }
}

function writeSelection(value: string) {
  try {
    window.localStorage.setItem(BOARD_SELECTION_KEY, value);
  } catch {
    // Penyimpanan browser tidak tersedia: pilihan hanya diingat selama layar terbuka.
  }
}

function validProjects(data: unknown): ProjectSummary[] | null {
  return Array.isArray(data) ? (data as ProjectSummary[]) : null;
}

type OpenTask = { projectId: string; taskId: string };

// Permintaan dari menu proyek agar board membuka panel Anggota atau dialog Ubah
// nama. `n` naik setiap permintaan; hanya berlaku untuk proyek `projectId`.
type BoardRequest = { projectId: string; kind: "members" | "rename"; n: number };

type LinkProps = {
  project: ProjectSummary;
  current: boolean;
  due: number;
  onSelect: (projectId: string) => void;
  onRequest: (projectId: string, kind: BoardRequest["kind"]) => void;
};

// Satu baris proyek di daftar kiri, dengan menu klik kanan (juga Shift+F10).
function ProjectLink({ project: p, current, due, onSelect, onRequest }: LinkProps) {
  const t = TEKS_MENU.proyek;
  const menu = useBoardMenu({
    label: t.menu(p.code, p.name),
    items: boardMenuItems(
      {
        id: "open",
        label: t.buka,
        icon: <IconLayoutKanban size={16} />,
        disabled: current && t.sedangTerbuka,
        onSelect: () => onSelect(p.id),
      },
      { id: "members", label: t.anggota, icon: <IconUsers size={16} />, onSelect: () => onRequest(p.id, "members") },
      p.canManage && {
        id: "rename",
        label: t.ubahNama,
        icon: <IconPencil size={16} />,
        onSelect: () => onRequest(p.id, "rename"),
      },
    ),
  });
  return (
    <li {...menu.triggerProps}>
      <button
        type="button"
        className="bd-link"
        title={`${p.code} ${p.name}`}
        aria-current={current ? "page" : undefined}
        onClick={() => onSelect(p.id)}
      >
        <span className="bd-link-code">{p.code}</span> <span className="bd-link-name">{p.name}</span>
        <span className="bd-link-count">
          <span className="sr-only">, </span>
          {p.openCount}
          <span className="sr-only"> task belum selesai</span>
        </span>
        <SidebarCount count={due} meaning={DUE_MEANING} className="bd-link-due" />
      </button>
      {menu.element}
    </li>
  );
}

// Task yang ditugaskan ke saya, belum Selesai, tenggat hari ini atau lewat (D1, D5).
// Kalau gagal dibaca, angkanya tidak tampil; daftar proyek tetap jalan.
function useDueSummary(): DueSummary | null {
  const [summary, setSummary] = useState<DueSummary | null>(null);
  const seq = useRef(0);
  useEffect(() => {
    const load = () => {
      const mine = ++seq.current;
      boardApi
        .myTasks()
        .then((tasks) => {
          if (mine === seq.current) setSummary(dueSummary(Array.isArray(tasks) ? tasks : [], todayIso()));
        })
        .catch(() => {});
    };
    load();
    const stop = subscribeBoard(load);
    const timer = window.setInterval(load, DUE_POLL_MS);
    return () => {
      seq.current++;
      stop();
      window.clearInterval(timer);
    };
  }, []);
  return summary;
}

export function BoardScreen() {
  const live = useBoardLive(boardApi.listProjects, "projects");
  const createOpts = useCreateOptions();
  const due = useDueSummary();
  // Proyek yang board-nya ditolak inti Rust (saya dikeluarkan) atau yang baru saja
  // saya tinggalkan. Disembunyikan sampai daftar proyek dari inti Rust ikut membuangnya.
  const [revoked, setRevoked] = useState<ReadonlySet<string>>(() => new Set());
  const listed = validProjects(live.data);
  const projects = useMemo(
    () => (listed && revoked.size > 0 ? listed.filter((p) => !revoked.has(p.id)) : listed),
    [listed, revoked],
  );
  // Proyek yang baru saya tinggalkan lewat panel Anggota: penjelasannya berbeda.
  const [leftId, setLeftId] = useState<string | null>(null);
  // Proyek yang baru saya ikuti dari Proyek lain: dibuka begitu muncul di daftar.
  const [joinedId, setJoinedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(readSelection);
  const [creating, setCreating] = useState(false);
  const [openTask, setOpenTask] = useState<OpenTask | null>(null);
  const [request, setRequest] = useState<BoardRequest | null>(null);
  const requestSeq = useRef(0);
  const [refreshKey, setRefreshKey] = useState(0);
  // Proyek yang judul board-nya difokus begitu tampil (setelah proyek dibuat).
  const [focusProject, setFocusProject] = useState<string | null>(null);
  const boardRef = useRef<ProjectBoardHandle>(null);
  const lostHeadingRef = useRef<HTMLHeadingElement>(null);
  const { reload, setData } = live;

  // Proyek yang sedang dibuka lalu hilang dari daftar setelah muat ulang
  // (misalnya saya dikeluarkan dari proyeknya). Dicek saat daftar berganti,
  // sebelum render, supaya board proyek lain tidak tampil sekejap.
  const [lost, setLost] = useState<ProjectSummary | null>(null);
  const [seen, setSeen] = useState<ProjectSummary[] | null>(null);
  const [seenListed, setSeenListed] = useState<ProjectSummary[] | null>(null);
  if (listed !== seenListed) {
    setSeenListed(listed);
    // Daftar baru dari inti Rust: yang sudah tidak ada di sana tidak perlu disembunyikan lagi.
    if (listed && revoked.size > 0) {
      const still = new Set([...revoked].filter((id) => listed.some((p) => p.id === id)));
      if (still.size !== revoked.size) setRevoked(still);
    }
    // Proyek yang pernah saya tinggalkan muncul lagi (saya ditambahkan kembali):
    // kalau nanti hilang lagi, penyebabnya belum tentu saya keluar sendiri.
    if (listed && leftId && !revoked.has(leftId) && listed.some((p) => p.id === leftId)) setLeftId(null);
  }
  if (projects !== seen) {
    setSeen(projects);
    if (seen && projects && selected !== MY_TASKS) {
      const shown = (selected ? seen.find((p) => p.id === selected) : undefined) ?? (lost?.id === selected ? null : seen[0]);
      if (shown && !projects.some((p) => p.id === shown.id)) {
        setLost(shown);
        setSelected(shown.id);
      }
    }
  }

  // Pilihan yang tersimpan bisa menunjuk proyek yang sudah tidak ada; yang
  // baru saja hilang tetap dipilih supaya penyebabnya bisa dijelaskan.
  const current =
    selected === MY_TASKS
      ? MY_TASKS
      : (projects?.find((p) => p.id === selected)?.id ??
        (lost && lost.id === selected ? lost.id : null) ??
        projects?.[0]?.id ??
        null);

  const select = useCallback((value: string) => {
    setSelected(value);
    writeSelection(value);
    // Pilihan sendiri menang atas pembukaan otomatis proyek yang baru diikuti.
    setJoinedId(null);
    // Permintaan menu yang lama tidak ikut terbuka lagi saat board dipasang ulang.
    setRequest(null);
  }, []);

  const requestPanel = useCallback(
    (projectId: string, kind: BoardRequest["kind"]) => {
      select(projectId);
      requestSeq.current += 1;
      setRequest({ projectId, kind, n: requestSeq.current });
    },
    [select],
  );

  const changed = useCallback(() => {
    setRefreshKey((n) => n + 1);
    void reload();
  }, [reload]);

  const projectsChanged = useCallback(() => void reload(), [reload]);
  const headingFocused = useCallback(() => setFocusProject(null), []);

  const projectLost = useCallback(
    (projectId: string, reason: "left" | "forbidden") => {
      if (reason === "left") setLeftId(projectId);
      setRevoked((prev) => (prev.has(projectId) ? prev : new Set(prev).add(projectId)));
      void reload();
    },
    [reload],
  );

  const joined = useCallback(
    (projectId: string) => {
      setJoinedId(projectId);
      setRevoked((prev) => {
        if (!prev.has(projectId)) return prev;
        const next = new Set(prev);
        next.delete(projectId);
        return next;
      });
      setLeftId((prev) => (prev === projectId ? null : prev));
      void reload();
    },
    [reload],
  );

  useEffect(() => {
    if (!joinedId || !projects?.some((p) => p.id === joinedId)) return;
    setLost(null);
    select(joinedId);
    setFocusProject(joinedId);
  }, [joinedId, projects, select]);

  const currentProject = projects?.find((p) => p.id === current) ?? null;
  const currentId = currentProject?.id ?? null;
  // Permintaan menu hanya berlaku selama board proyeknya tetap terpasang. Begitu
  // board itu tidak tampil (misalnya proyeknya hilang dari daftar), permintaan
  // dibuang, supaya board yang dipasang lagi nanti tidak membuka panelnya sendiri.
  if (request && request.projectId !== currentId) setRequest(null);
  const boardRequest = useMemo(
    () => (request && request.projectId === currentId ? { kind: request.kind, n: request.n } : undefined),
    [request, currentId],
  );
  const lostShown = projects && lost && current === lost.id && !currentProject ? lost : null;
  const nextProject = projects?.[0] ?? null;

  // Fokus yang tertinggal di board yang hilang dipindah ke penjelasannya, juga
  // setelah dialog detail task ditutup (kartu pembukanya sudah tidak ada).
  // Ditunda satu giliran supaya dialog selesai mengembalikan fokusnya dulu.
  const taskIsOpen = !!openTask;
  useEffect(() => {
    if (!lostShown || taskIsOpen) return;
    const timer = window.setTimeout(() => {
      const active = document.activeElement;
      if (!active || active === document.body) lostHeadingRef.current?.focus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [lostShown, taskIsOpen]);

  // Tombol Proyek baru hanya untuk superadmin dan admin departemen. Selama data
  // organisasi belum terbaca (atau gagal dibaca), tombol tetap tampil; dialognya menjelaskan.
  const canCreateProject = createOpts.status !== "ready" || createOpts.options.canCreate;
  const overview = createOpts.status === "ready" ? createOpts.data.overview : null;
  const leftSelf = !!lostShown && leftId === lostShown.id;

  return (
    <main className="bd" aria-labelledby="page-title">
      <nav className="bd-nav" aria-label="Task saya dan proyek">
        <h1 id="page-title" className="page-title bd-title">
          Board
        </h1>
        <ul className="bd-navlist">
          <li>
            <button
              type="button"
              className="bd-link"
              aria-current={current === MY_TASKS ? "page" : undefined}
              onClick={() => select(MY_TASKS)}
            >
              <IconListCheck size={18} aria-hidden="true" />
              <span className="bd-link-name">Task saya</span>
              <SidebarCount count={due?.total ?? 0} meaning={DUE_MEANING} className="bd-link-due" />
            </button>
          </li>
        </ul>

        <h2 className="bd-lbl">Proyek</h2>
        {live.loading && !projects && (
          <p className="bd-nav-note" role="status">
            Memuat proyek...
          </p>
        )}
        {projects && projects.length === 0 && <p className="bd-nav-note">Belum ada proyek.</p>}
        {projects && projects.length > 0 && (
          <ul className="bd-navlist">
            {projects.map((p) => (
              <ProjectLink
                key={p.id}
                project={p}
                current={current === p.id}
                due={due?.byProject[p.id] ?? 0}
                onSelect={select}
                onRequest={requestPanel}
              />
            ))}
          </ul>
        )}
        {projects && canCreateProject && (
          <button type="button" className="btn btn-ghost btn-sm bd-new" onClick={() => setCreating(true)}>
            <IconPlus size={16} aria-hidden="true" />
            Proyek baru
          </button>
        )}
        {projects && projects.length > 0 && !canCreateProject && <p className="bd-nav-note">{CREATE_NOTE}</p>}
        {overview?.isSuperadmin && <OutsideProjects myKey={overview.publicKey} onJoined={joined} />}
      </nav>

      <div className="bd-main">
        <div className="sr-only" role="status">
          {lostShown
            ? leftSelf
              ? `Anda sudah keluar dari proyek ${lostShown.code} ${lostShown.name}.`
              : `Proyek ${lostShown.code} ${lostShown.name} tidak tersedia lagi.`
            : ""}
        </div>
        {!projects && !live.loading && (
          <div className="bd-pad bd-narrow" role="alert">
            <ErrorAlert title="Daftar proyek belum terbaca">
              <p>{live.error?.message ?? "Inti Mira tidak mengirim daftar proyek."}</p>
              <p>Tunggu sebentar lalu coba lagi. Data board tersimpan di laptop ini, tidak ada yang hilang.</p>
              <button type="button" className="btn btn-ghost btn-sm bd-retry" onClick={() => void reload()}>
                Coba lagi
              </button>
            </ErrorAlert>
          </div>
        )}
        {!projects && live.loading && (
          <p className="bd-pad hint" role="status">
            Memuat board...
          </p>
        )}
        {projects && current === MY_TASKS && (
          <MyTasks taskOpen={!!openTask} onOpenTask={(projectId, taskId) => setOpenTask({ projectId, taskId })} />
        )}
        {projects && current !== MY_TASKS && currentProject && (
          <ProjectBoard
            key={currentProject.id}
            ref={boardRef}
            projectId={currentProject.id}
            refreshKey={refreshKey}
            taskOpen={!!openTask}
            focusHeading={focusProject === currentProject.id}
            onHeadingFocused={headingFocused}
            onOpenTask={(taskId) => setOpenTask({ projectId: currentProject.id, taskId })}
            onProjectsChanged={projectsChanged}
            onLost={projectLost}
            request={boardRequest}
          />
        )}
        {lostShown && (
          <div className="bd-empty">
            <h2 className="bd-empty-title" ref={lostHeadingRef} tabIndex={-1}>
              {leftSelf
                ? `Anda sudah keluar dari proyek ${lostShown.code} ${lostShown.name}`
                : `Proyek ${lostShown.code} ${lostShown.name} tidak tersedia lagi`}
            </h2>
            <p>
              {leftSelf
                ? "Proyek ini tidak tampil lagi di board Anda, dan laptop ini berhenti menerima data baru proyek ini."
                : "Anda tidak bisa membuka proyek ini lagi. Biasanya karena pengelola proyek mengeluarkan Anda dari anggotanya."}
            </p>
            <p>Kalau masih perlu, minta pengelola proyek menambahkan Anda lagi.</p>
            {nextProject && (
              <button type="button" className="btn" onClick={() => select(nextProject.id)}>
                Buka {nextProject.code} {nextProject.name}
              </button>
            )}
          </div>
        )}
        {projects && projects.length === 0 && current !== MY_TASKS && !lostShown && (
          <div className="bd-empty">
            <h2 className="bd-empty-title">{canCreateProject ? "Belum ada proyek" : "Belum ada proyek yang bisa Anda lihat"}</h2>
            <p>
              Satu proyek punya satu board dengan kolom To do, Dikerjakan, dan Selesai. Task diberi nomor dari kode
              proyeknya, misalnya PA-1 untuk proyek berkode PA.
            </p>
            {canCreateProject ? (
              <button type="button" className="btn" onClick={() => setCreating(true)}>
                <IconPlus size={16} aria-hidden="true" />
                Buat proyek pertama
              </button>
            ) : (
              <p>
                {CREATE_NOTE} Board proyek muncul di sini setelah pengelolanya menambahkan Anda sebagai anggota.
              </p>
            )}
          </div>
        )}
      </div>

      <NewProjectDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={(project) => {
          setCreating(false);
          if (projects && !projects.some((p) => p.id === project.id)) setData([...projects, project]);
          select(project.id);
          setFocusProject(project.id);
          void reload();
        }}
      />

      {openTask && (
        <TaskDetail
          projectId={openTask.projectId}
          taskId={openTask.taskId}
          onClose={() => setOpenTask(null)}
          onChanged={changed}
          onDeleted={(taskId, code) => boardRef.current?.taskDeleted(taskId, code)}
        />
      )}
    </main>
  );
}
