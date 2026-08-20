import type { ReactNode } from "react";

export function EmptyState({ title, children, action }: { title?: string; children: ReactNode; action?: ReactNode }) {
  return <div className="empty-note">{title && <strong>{title}</strong>}<span>{children}</span>{action}</div>;
}
