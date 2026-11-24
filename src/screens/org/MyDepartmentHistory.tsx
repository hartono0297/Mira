import type { AdminEvent } from "../../api/division";
import { formatDateTime } from "../../api/format";
import { DIVISION_TEXT } from "../../i18n/org-division";

export function MyDepartmentHistory({ events }: { events: AdminEvent[] }) {
  const T = DIVISION_TEXT.history;
  return (
    <section className="set-section md-block" aria-labelledby="md-history-title">
      <div>
        <h2 id="md-history-title" className="set-title">
          {T.title}
        </h2>
        <p className="hint">{T.intro}</p>
      </div>
      {events.length === 0 ? (
        <div className="org-empty">
          <p>{T.empty}</p>
        </div>
      ) : (
        <ol className="row-list md-history">
          {events.map((e, i) => (
            <li key={`${e.at}-${i}`} className="row">
              <div className="row-main">
                <span className={e.status === "rejected" ? "md-history-text md-history-rejected" : "md-history-text"}>
                  {e.admin ? T.made(e.byName, e.targetName) : T.removed(e.byName, e.targetName)}
                </span>
                <time className="row-sub" dateTime={e.at}>
                  {formatDateTime(e.at)}
                </time>
              </div>
              {e.status === "rejected" && <span className="chip">{T.rejected}</span>}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
