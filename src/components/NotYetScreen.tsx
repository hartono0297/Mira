import type { Icon } from "@tabler/icons-react";
import "./not-yet.css";

type Props = {
  title: string;
  icon: Icon;
  heading: string;
  body: string;
  stage: string;
};

// Tampilan kosong yang jujur untuk menu yang belum dibangun. Tanpa data contoh.
export function NotYetScreen({ title, icon: FeatureIcon, heading, body, stage }: Props) {
  return (
    <main className="notyet-wrap" aria-labelledby="page-title">
      <header className="page-head">
        <h1 id="page-title" className="page-title">
          {title}
        </h1>
      </header>
      <div className="notyet">
        <div className="notyet-icon">
          <FeatureIcon size={28} aria-hidden="true" />
        </div>
        <h2 className="notyet-heading">{heading}</h2>
        <p className="notyet-body">{body}</p>
        <p className="notyet-stage">{stage}</p>
      </div>
    </main>
  );
}
