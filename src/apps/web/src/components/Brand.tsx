import { Link } from "react-router-dom";

export function Brand({ to = "/", role }: { to?: string; role?: string }) {
  return (
    <Link className="app-brand" to={to} aria-label={`AGMATH${role ? ` ${role}` : ""}`}>
      <span className="app-brand-mark" aria-hidden="true">∴</span>
      <span className="app-brand-word">AGMATH</span>
    </Link>
  );
}
