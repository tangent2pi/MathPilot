import { Outlet } from "react-router-dom";

export function PageTransition() {
  // Route ownership must change immediately. Keeping the previous outlet alive for an
  // exit animation lets its pending mutations navigate after the user has already left.
  return <div className="route-stage"><Outlet /></div>;
}
