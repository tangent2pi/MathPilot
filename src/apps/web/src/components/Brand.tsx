import { Link } from "react-router-dom";
import { PRODUCT_ICON, PRODUCT_NAME, PRODUCT_NAME_EN, PRODUCT_TITLE } from "../lib/brand";

export function Brand({ to = "/", role }: { to?: string; role?: string }) {
  return (
    <Link className="app-brand" to={to} aria-label={`${PRODUCT_TITLE}${role ? ` ${role}` : ""}`}>
      <img className="app-brand-mark" src={PRODUCT_ICON} width="256" height="256" alt="" aria-hidden="true" />
      <span className="app-brand-word"><strong>{PRODUCT_NAME}</strong><small>{PRODUCT_NAME_EN}</small></span>
    </Link>
  );
}
