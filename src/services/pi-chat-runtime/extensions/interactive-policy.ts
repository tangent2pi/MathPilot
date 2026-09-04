import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CANONICAL_THREAD = /^thr_[A-Za-z0-9]{8,}$/;
const INTERACTIVE_TOOLS = [
  "read", "grep", "learning_action",
] as const;

const isInteractiveThread = (cwd: string): boolean => CANONICAL_THREAD.test(path.basename(cwd));

/** Canonical interactive sessions are read-only teaching sessions. Content
 * authoring (`respond`, content library) and general mutation/shell tools stay
 * exclusive to the separate KTQ/ER workspaces. */
export default function interactivePolicy(pi: ExtensionAPI): void {
  const enforce = (cwd: string) => {
    if (!isInteractiveThread(cwd)) return;
    pi.setThinkingLevel("high");
    pi.setActiveTools([...INTERACTIVE_TOOLS]);
  };
  pi.on("session_start", (_event, context) => enforce(context.cwd));
  // Reassert immediately before every run so a reload or another extension
  // cannot accidentally widen the foreground tool surface.
  pi.on("before_agent_start", (_event, context) => {
    enforce(context.cwd);
  });
}
