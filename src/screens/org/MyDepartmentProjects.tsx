import { IconLayoutKanban } from "@tabler/icons-react";
import type { DeptProject } from "../../api/division";
import { DIVISION_TEXT } from "../../i18n/org-division";

type Props = {
  projects: DeptProject[];
  onOpenProject?: (projectId: string) => void;
};

export function MyDepartmentProjects({ projects, onOpenProject }: Props) {
  const T = DIVISION_TEXT.projects;
  const list = [...projects].sort((a, b) => a.name.localeCompare(b.name));
  return (
    <section className="set-section md-block" aria-labelledby="md-projects-title">
      <h2 id="md-projects-title" className="set-title">
        {T.title}
      </h2>
      {list.length === 0 ? (
        <div className="org-empty">
          <p>{T.empty}</p>
        </div>
      ) : (
        <ul className="row-list">
          {list.map((p) => (
            <li key={p.id} className="row">
              <div className="row-main">
                <span className="row-name">{p.name}</span>
                <span className="row-sub">{p.divisionName ? T.division(p.divisionName) : T.noDivision}</span>
                <span className="row-sub">
                  {p.members.length > 0 ? T.members(p.members.map((m) => m.displayName).join(", ")) : T.noMembers}
                </span>
              </div>
              {onOpenProject && (
                <div className="row-actions">
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    aria-label={T.openBoardAria(p.name)}
                    onClick={() => onOpenProject(p.id)}
                  >
                    <IconLayoutKanban size={16} aria-hidden="true" />
                    {T.openBoard}
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
