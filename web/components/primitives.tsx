import type { ReactNode } from "react";

type PanelTone = "cyan" | "amber" | "coral" | "slate";
type PillTone = "good" | "warn" | "bad" | "neutral";

function joinClasses(...values: Array<string | false | null | undefined>): string {
  return values.filter((value): value is string => typeof value === "string" && value.length > 0).join(" ");
}

export function Panel({
  eyebrow,
  title,
  tone = "slate",
  actions,
  className,
  children,
}: {
  eyebrow?: string;
  title: string;
  tone?: PanelTone;
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={joinClasses("panel", `panel-${tone}`, className)}>
      <div className="panel-header">
        <div>
          {eyebrow ? <div className="panel-eyebrow">{eyebrow}</div> : null}
          <h2 className="panel-title">{title}</h2>
        </div>
        {actions ? <div className="panel-actions">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

export function MetricTile({
  label,
  value,
  detail,
  tone = "slate",
}: {
  label: string;
  value: string;
  detail?: string;
  tone?: PanelTone;
}) {
  return (
    <article className={joinClasses("metric-tile", `metric-${tone}`)}>
      <div className="metric-label">{label}</div>
      <div className="metric-value">{value}</div>
      {detail ? <div className="metric-detail">{detail}</div> : null}
    </article>
  );
}

export function StatusPill({ tone = "neutral", children }: { tone?: PillTone; children: ReactNode }) {
  return <span className={joinClasses("status-pill", `status-${tone}`)}>{children}</span>;
}

export function EmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="empty-state">
      <div className="empty-title">{title}</div>
      <div className="empty-detail">{detail}</div>
    </div>
  );
}