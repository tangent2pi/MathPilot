import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const ATTACHMENT_CONTEXT_TYPE = "mathpilot.turn-attachments";

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface WorkspaceAttachment {
  id: string;
  storageObjectId: string;
  versionId: string;
  sha256: string;
  originalName: string;
  workspacePath: string;
  mimeType: string;
  byteSize: number;
  uploadedAt: string;
}

export interface AttachmentTurn {
  version: 1;
  id: string;
  prompt: string;
  attachmentIds: string[];
  createdAt: string;
}

// Host-only state deliberately lives beside, not inside, the model workspace.
// Sandbox tools are scoped to cwd and cannot forge attachment bindings.
const stateRoot = (cwd: string) => path.join(path.dirname(cwd), ".attachment-state", path.basename(cwd));
const pendingRoot = (cwd: string) => path.join(stateRoot(cwd), "pending-attachments");
const boundRoot = (cwd: string) => path.join(stateRoot(cwd), "bound-attachments");
const turnsRoot = (cwd: string) => path.join(stateRoot(cwd), "attachment-turns");

const jsonPath = (directory: string, id: string): string => {
  if (!ID_PATTERN.test(id)) throw new Error("invalid attachment id");
  return path.join(directory, `${id}.json`);
};

const ensurePrivateDirectory = async (directory: string): Promise<void> => {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
};

const readJson = async <T>(file: string): Promise<T> =>
  JSON.parse(await readFile(file, "utf8")) as T;

export const isAttachmentId = (value: string): boolean => ID_PATTERN.test(value);

export async function savePendingAttachment(cwd: string, attachment: WorkspaceAttachment): Promise<void> {
  await ensurePrivateDirectory(stateRoot(cwd));
  await ensurePrivateDirectory(pendingRoot(cwd));
  const file = jsonPath(pendingRoot(cwd), attachment.id);
  await writeFile(file, JSON.stringify(attachment, null, 2), { encoding: "utf8", flag: "wx", mode: 0o600 });
  await chmod(file, 0o600);
}

/** Remove a pending record when persisting its durable metadata fails. */
export async function removePendingAttachment(cwd: string, attachmentId: string): Promise<void> {
  await rm(jsonPath(pendingRoot(cwd), attachmentId), { force: true });
}

/**
 * Atomically claims server-issued attachment ids for one user turn. Moving the
 * records prevents a browser from replaying an id in another message.
 */
export async function bindAttachmentTurn(cwd: string, turn: AttachmentTurn): Promise<void> {
  await ensurePrivateDirectory(stateRoot(cwd));
  await Promise.all([ensurePrivateDirectory(boundRoot(cwd)), ensurePrivateDirectory(turnsRoot(cwd))]);
  const moved: string[] = [];
  try {
    for (const id of turn.attachmentIds) {
      await rename(jsonPath(pendingRoot(cwd), id), jsonPath(boundRoot(cwd), id));
      moved.push(id);
    }
    const file = jsonPath(turnsRoot(cwd), turn.id);
    await writeFile(file, JSON.stringify(turn, null, 2), { encoding: "utf8", flag: "wx", mode: 0o600 });
    await chmod(file, 0o600);
  } catch (error) {
    await Promise.all(moved.map((id) =>
      rename(jsonPath(boundRoot(cwd), id), jsonPath(pendingRoot(cwd), id)).catch(() => undefined),
    ));
    throw error;
  }
}

export async function releaseAttachmentTurn(cwd: string, turn: AttachmentTurn): Promise<void> {
  await rm(jsonPath(turnsRoot(cwd), turn.id), { force: true });
  await Promise.all(turn.attachmentIds.map((id) =>
    rename(jsonPath(boundRoot(cwd), id), jsonPath(pendingRoot(cwd), id)).catch(() => undefined),
  ));
}

const validAttachment = (value: WorkspaceAttachment): boolean =>
  typeof value === "object" && value !== null
  && isAttachmentId(value.id)
  && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value.storageObjectId)
  && typeof value.versionId === "string" && value.versionId.length > 0
  && /^[0-9a-f]{64}$/.test(value.sha256)
  && typeof value.originalName === "string"
  && typeof value.workspacePath === "string"
  && /^input\/original\/[^/\\\u0000]+$/.test(value.workspacePath)
  && typeof value.mimeType === "string"
  && Number.isSafeInteger(value.byteSize) && value.byteSize >= 0
  && typeof value.uploadedAt === "string";

const validTurn = (value: AttachmentTurn): boolean =>
  typeof value === "object" && value !== null
  && value.version === 1
  && isAttachmentId(value.id)
  && typeof value.prompt === "string"
  && Array.isArray(value.attachmentIds)
  && value.attachmentIds.length > 0
  && new Set(value.attachmentIds).size === value.attachmentIds.length
  && value.attachmentIds.every((id) => typeof id === "string" && isAttachmentId(id))
  && typeof value.createdAt === "string";

export async function findAttachmentTurn(
  cwd: string,
  prompt: string,
  announcedTurnIds: ReadonlySet<string>,
): Promise<{ turn: AttachmentTurn; attachments: WorkspaceAttachment[] } | undefined> {
  const names = await readdir(turnsRoot(cwd)).catch(() => [] as string[]);
  const candidates: AttachmentTurn[] = [];
  for (const name of names.filter((name) => name.endsWith(".json")).sort()) {
    const turn = await readJson<AttachmentTurn>(path.join(turnsRoot(cwd), name)).catch(() => undefined);
    if (turn && validTurn(turn) && !announcedTurnIds.has(turn.id) && turn.prompt === prompt) candidates.push(turn);
  }
  candidates.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const turn = candidates[0];
  if (!turn) return undefined;

  const attachments: WorkspaceAttachment[] = [];
  for (const id of turn.attachmentIds) {
    const attachment = await readJson<WorkspaceAttachment>(jsonPath(boundRoot(cwd), id)).catch(() => undefined);
    if (!attachment || !validAttachment(attachment) || attachment.id !== id) {
      throw new Error(`invalid bound attachment: ${id}`);
    }
    attachments.push(attachment);
  }
  return { turn, attachments };
}

export async function listBoundAttachments(cwd: string): Promise<WorkspaceAttachment[]> {
  const attachments: WorkspaceAttachment[] = [];
  for (const name of (await readdir(boundRoot(cwd)).catch(() => [] as string[])).filter((entry) => entry.endsWith(".json")).sort()) {
    const attachment = await readJson<WorkspaceAttachment>(path.join(boundRoot(cwd), name)).catch(() => undefined);
    if (attachment && validAttachment(attachment)) attachments.push(attachment);
  }
  return attachments;
}
