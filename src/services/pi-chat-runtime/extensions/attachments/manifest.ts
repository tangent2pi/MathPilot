import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const ATTACHMENT_CONTEXT_TYPE = "mathpilot.turn-attachments";

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface WorkspaceAttachment {
  id: string;
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

const readJson = async <T>(file: string): Promise<T> =>
  JSON.parse(await readFile(file, "utf8")) as T;

export const isAttachmentId = (value: string): boolean => ID_PATTERN.test(value);

export async function savePendingAttachment(cwd: string, attachment: WorkspaceAttachment): Promise<void> {
  await mkdir(pendingRoot(cwd), { recursive: true });
  await writeFile(
    jsonPath(pendingRoot(cwd), attachment.id),
    JSON.stringify(attachment, null, 2),
    { encoding: "utf8", flag: "wx" },
  );
}

/**
 * Atomically claims server-issued attachment ids for one user turn. Moving the
 * records prevents a browser from replaying an id in another message.
 */
export async function bindAttachmentTurn(cwd: string, turn: AttachmentTurn): Promise<void> {
  await Promise.all([mkdir(boundRoot(cwd), { recursive: true }), mkdir(turnsRoot(cwd), { recursive: true })]);
  const moved: string[] = [];
  try {
    for (const id of turn.attachmentIds) {
      await rename(jsonPath(pendingRoot(cwd), id), jsonPath(boundRoot(cwd), id));
      moved.push(id);
    }
    await writeFile(
      jsonPath(turnsRoot(cwd), turn.id),
      JSON.stringify(turn, null, 2),
      { encoding: "utf8", flag: "wx" },
    );
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
  && typeof value.originalName === "string"
  && typeof value.workspacePath === "string"
  && value.workspacePath.startsWith("input/original/")
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
