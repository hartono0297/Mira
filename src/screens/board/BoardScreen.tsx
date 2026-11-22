import { IconListCheck, IconPlus } from "@tabler/icons-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../api";
import { boardApi, type ProjectSummary } from "../../api/board";
import { useLive } from "../../api/useLive";
import { ErrorAlert } from "../../components/ErrorAlert";
import { teamLabel } from "./format";
import { MyTasks } from "./MyTasks";
import { NewProjectDialog, teamChoices } from "./NewProjectDialog";
import { ProjectBoard, type ProjectBoardHandle } from "./ProjectBoard";
import { TaskDetail } from "./TaskDetail";
import { useBoardLive } from "./useBoardLive";
import "./board.css";

// Pilihan terakhir di sub-menu Board, per laptop.
export const BOARD_SELECTION_KEY = "mira.board.selection";
export const MY_TASKS = "__mine__";
// Direktori organisasi (siapa admin tim mana) dibaca ulang lewat event; polling hanya cadangan.
const DIRECTORY_POLL_MS = 30000;

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

export function BoardScreen() {
  const live = useBoardLive(boardApi.listProjects, "projects");
  const dirLive = useLive(api.getDirectory, "mira://directory", DIRECTORY_POLL_MS);
  const projects = validProjects(live.data);
  const [selected, setSelected] = useState<string | null>(readSelection);
  const [creating, setCreating] = useState(false);
  const [openTask, setOpenTask] = useState<OpenTask | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  // Proyek yang judul board-nya difokus begitu tampil (setelah proyek dibuat).
  const [focusProject, setFocusProject] = useState<string | null>(null);
  const boardRef = useRef<ProjectBoardHandle>(null);
  const lostHeadingRef = useRef<HTMLHeadingElement>(null);
  const { reload, setData } = live;

  // Proyek yang sedang dibuka lalu hilang dari daftar setelah muat ulang
  // (misalnya saya dikeluarkan dari timnya). Dicek saat daftar berganti,
  // sebelum render, supaya board proyek lain tidak tampil sekejap.
  const [lost, setLost] = useState<ProjectSummary | null>(null);
  const [seen, setSeen] = useState<ProjectSummary[] | null>(null);
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
  }, []);

  const changed = useCallback(() => {
    setRefreshKey((n) => n + 1);
    void reload();
  }, [reload]);

  const projectsChanged = useCallback(() => void reload(), [reload]);
  const headingFocused = useCallback(() => setFocusProject(null), []);

  const currentProject = projects?.find((p) => p.id === current) ?? null;
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

  // Tombol Proyek baru hanya untuk yang bisa membuat proyek di tim mana pun atau
  // tanpa tim. Selama direktori belum terbaca, tombol tetap tampil; dialognya menjelaskan.
  const choices = dirLive.data ? teamChoices(dirLive.data) : null;
  const canCreateProject = !choices || choices.teams.length > 0 || choices.allowOrg;

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
              <li key={p.id}>
                <button
                  type="button"
                  className="bd-link"
                  title={`${p.code} ${p.name}`}
                  aria-current={current === p.id ? "page" : undefined}
                  onClick={() => select(p.id)}
                >
                  <span className="bd-link-code">{p.code}</span>{" "}
                  <span className="bd-link-name">{p.name}</span>
                  <span className="bd-link-count">
                    <span className="sr-only">, </span>
                    {p.openCount}
                    <span className="sr-only"> task belum selesai</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {projects && canCreateProject && (
          <button type="button" className="btn btn-ghost btn-sm bd-new" onClick={() => setCreating(true)}>
            <IconPlus size={16} aria-hidden="true" />
            Proyek baru
          </button>
        )}
      </nav>

      <div className="bd-main">
        <div className="sr-only" role="status">
          {lostShown ? `Proyek ${lostShown.code} ${lostShown.name} tidak tersedia lagi.` : ""}
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
          />
        )}
        {lostShown && (
          <div className="bd-empty">
            <h2 className="bd-empty-title" ref={lostHeadingRef} tabIndex={-1}>
              Proyek {lostShown.code} {lostShown.name} tidak tersedia lagi
            </h2>
            <p>
              {lostShown.teamName
                ? `Proyek ini milik ${teamLabel(lostShown.teamName)} dan tidak ada lagi di daftar Anda. Biasanya karena Anda dikeluarkan dari tim itu, atau akses Tamu Anda ke proyek ini dicabut.`
                : "Proyek ini tidak ada lagi di daftar Anda. Biasanya karena peran Anda di organisasi berubah, misalnya menjadi Tamu."}
            </p>
            <p>
              {lostShown.teamName
                ? "Kalau masih perlu, minta admin tim itu menambahkan Anda lagi."
                : "Kalau masih perlu, tanyakan ke superadmin organisasi."}
            </p>
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
                Proyek dibuat oleh superadmin atau admin tim. Board proyek tim Anda muncul di sini setelah proyeknya
                dibuat.
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
