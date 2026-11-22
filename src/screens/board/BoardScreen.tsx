import { IconListCheck, IconPlus } from "@tabler/icons-react";
import { useCallback, useRef, useState } from "react";
import { boardApi, type ProjectSummary } from "../../api/board";
import { ErrorAlert } from "../../components/ErrorAlert";
import { MyTasks } from "./MyTasks";
import { NewProjectDialog } from "./NewProjectDialog";
import { ProjectBoard, type ProjectBoardHandle } from "./ProjectBoard";
import { TaskDetail } from "./TaskDetail";
import { useBoardLive } from "./useBoardLive";
import "./board.css";

// Pilihan terakhir di sub-menu Board, per laptop.
export const BOARD_SELECTION_KEY = "mira.board.selection";
export const MY_TASKS = "__mine__";

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
  const projects = validProjects(live.data);
  const [selected, setSelected] = useState<string | null>(readSelection);
  const [creating, setCreating] = useState(false);
  const [openTask, setOpenTask] = useState<OpenTask | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  // Proyek yang judul board-nya difokus begitu tampil (setelah proyek dibuat).
  const [focusProject, setFocusProject] = useState<string | null>(null);
  const boardRef = useRef<ProjectBoardHandle>(null);
  const { reload, setData } = live;

  // Pilihan yang tersimpan bisa menunjuk proyek yang sudah tidak ada.
  const current =
    selected === MY_TASKS
      ? MY_TASKS
      : projects?.find((p) => p.id === selected)?.id ?? projects?.[0]?.id ?? null;

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
        {projects && (
          <button type="button" className="btn btn-ghost btn-sm bd-new" onClick={() => setCreating(true)}>
            <IconPlus size={16} aria-hidden="true" />
            Proyek baru
          </button>
        )}
      </nav>

      <div className="bd-main">
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
        {projects && current === MY_TASKS && <MyTasks onOpenTask={(projectId, taskId) => setOpenTask({ projectId, taskId })} />}
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
        {projects && projects.length === 0 && current !== MY_TASKS && (
          <div className="bd-empty">
            <h2 className="bd-empty-title">Belum ada proyek</h2>
            <p>
              Satu proyek punya satu board dengan kolom To do, Dikerjakan, dan Selesai. Task diberi nomor dari kode
              proyeknya, misalnya PA-1 untuk proyek berkode PA.
            </p>
            <button type="button" className="btn" onClick={() => setCreating(true)}>
              <IconPlus size={16} aria-hidden="true" />
              Buat proyek pertama
            </button>
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
