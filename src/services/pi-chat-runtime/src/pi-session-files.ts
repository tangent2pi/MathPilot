import { link, lstat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";

export interface EnsuredPiSessionFile {
  sessionFile: string;
  created: boolean;
}

/**
 * Provision a cold Pi session through the SDK's cwd-scoped storage convention.
 * React Pi uses the same convention when its supervisor discovers a session,
 * so hosts must not place JSONL files directly in the agent sessions root.
 */
export async function ensurePiSessionFile(
  workspacePath: string,
  sessionId: string,
  initializeNew?: (manager: SessionManager) => Promise<void> | void,
): Promise<EnsuredPiSessionFile> {
  const findExisting = async (): Promise<string | undefined> =>
    (await SessionManager.list(workspacePath)).find((candidate) => candidate.id === sessionId)?.path;

  const existing = await findExisting();
  if (existing) return { sessionFile: existing, created: false };

  const manager = SessionManager.create(workspacePath, undefined, { id: sessionId });
  const sessionFile = manager.getSessionFile();
  const header = manager.getHeader();
  if (!sessionFile || !header) throw new Error("Pi did not allocate a persistent canonical session");
  await initializeNew?.(manager);
  const entries = [header, ...manager.getEntries()];
  try {
    await writeFile(sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    return { sessionFile, created: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const raced = await findExisting();
    if (!raced) throw error;
    return { sessionFile: raced, created: false };
  }
}

const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT";

const validateSessionIdentity = (
  sessionFile: string,
  workspacePath: string,
  sessionId: string,
): void => {
  const manager = SessionManager.open(sessionFile);
  if (manager.getSessionId() !== sessionId || path.resolve(manager.getCwd()) !== path.resolve(workspacePath)) {
    throw new Error("Pi session identity does not match its canonical thread mapping");
  }
};

/**
 * Relocate the pre-SDK-layout files once written directly under
 * agent/sessions/. SessionManager remains the authority for the destination
 * directory and for transcript identity validation. A hard-link followed by
 * unlink gives us no-clobber behavior; if the process stops between those two
 * operations, the next attempt recognizes the shared inode and finishes the
 * move without duplicating or replacing a transcript.
 */
export async function relocateLegacyPiSessionFile(
  workspacePath: string,
  sessionId: string,
  legacySessionFile: string,
): Promise<string> {
  const findSdkSession = async (): Promise<string | undefined> =>
    (await SessionManager.list(workspacePath)).find((candidate) => candidate.id === sessionId)?.path;

  const existing = await findSdkSession();
  let legacyInfo: Awaited<ReturnType<typeof lstat>> | undefined;
  try {
    legacyInfo = await lstat(legacySessionFile);
  } catch (error) {
    if (!missing(error)) throw error;
  }
  if (legacyInfo && (legacyInfo.isSymbolicLink() || !legacyInfo.isFile())) {
    throw new Error("legacy Pi session path must be a regular file");
  }

  if (existing) {
    validateSessionIdentity(existing, workspacePath, sessionId);
    if (!legacyInfo) return existing;
    const existingInfo = await lstat(existing);
    if (legacyInfo.dev !== existingInfo.dev || legacyInfo.ino !== existingInfo.ino) {
      throw new Error("conflicting legacy and SDK Pi sessions exist for one canonical thread");
    }
    await unlink(legacySessionFile);
    return existing;
  }
  if (!legacyInfo) throw new Error("mapped legacy Pi session file is missing");

  validateSessionIdentity(legacySessionFile, workspacePath, sessionId);
  // Creating a manager without persisting an entry asks the pinned SDK for its
  // current cwd-scoped directory without reimplementing its path encoding.
  const sdkSessionDirectory = SessionManager.create(workspacePath).getSessionDir();
  const destination = path.join(sdkSessionDirectory, path.basename(legacySessionFile));
  try {
    await link(legacySessionFile, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const destinationInfo = await lstat(destination);
    if (legacyInfo.dev !== destinationInfo.dev || legacyInfo.ino !== destinationInfo.ino) {
      throw new Error("Pi session relocation destination already contains another transcript");
    }
  }
  validateSessionIdentity(destination, workspacePath, sessionId);
  await unlink(legacySessionFile);
  const discovered = await findSdkSession();
  if (!discovered || path.resolve(discovered) !== path.resolve(destination)) {
    throw new Error("relocated Pi session is not discoverable through SessionManager");
  }
  return discovered;
}
