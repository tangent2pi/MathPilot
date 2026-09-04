import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  CONTENT_POLICIES,
  immutableObjectDescriptorSchema,
  storageObjectResolveRequestSchema,
  type ImmutableObjectDescriptor,
} from "@mathpilot/content-integrity";
import {
  MAXIMUM_INTERACTIVE_PREPARE_RESPONSE_BYTES,
  parseInteractivePrepareResponse as parseSharedInteractivePrepareResponse,
  parseInteractiveWorkspaceProjection,
} from "@mathpilot/contracts";
import { canonicalJson, resolveAndMaterializeObjects } from "@mathpilot/content-integrity/node";
import type { InternalActor, InternalServiceRuntime } from "@mathpilot/internal-service";
import {
  interactiveReceiptBinding,
  parseInteractiveAdmissionReceipt,
  type InteractiveAdmissionReceipt,
} from "../extensions/lib/interactive-receipt.ts";
import type { PiInputAttachment } from "@assistant-ui/react-pi";
import type { CanonicalSyncMessage } from "./pi-canonical-sync.ts";

type JsonObject = Record<string, unknown>;

type ProjectionFile = { path: string; content: string };
type ProjectionObject = { path: string; descriptor: ImmutableObjectDescriptor };
type WorkspaceProjection = {
  files: readonly ProjectionFile[];
  objects: readonly ProjectionObject[];
  manifest: JsonObject;
};

const descriptorMatchesAttachment = (
  attachment: Extract<CanonicalSyncMessage["parts"][number], { type: "attachment" }>,
  descriptor: ImmutableObjectDescriptor,
): boolean => descriptor.object_ref === attachment.attachment_ref
  && descriptor.version_id === attachment.version_id
  && descriptor.sha256 === attachment.sha256
  && descriptor.byte_size === attachment.byte_size
  && descriptor.mime_type === attachment.mime_type
  && descriptor.original_name === attachment.name;

const parseWorkspaceProjection = (value: unknown): WorkspaceProjection => {
  const candidate = parseInteractiveWorkspaceProjection(value);
  const files = candidate.files.map((item) => Object.freeze({ path: item.path, content: item.content }));
  const objects = candidate.objects.map((item) => {
    return Object.freeze({
      path: item.path,
      descriptor: immutableObjectDescriptorSchema.parse(item.descriptor),
    });
  });
  return Object.freeze({
    files: Object.freeze(files),
    objects: Object.freeze(objects),
    manifest: Object.freeze(candidate.manifest as JsonObject),
  });
};

type InteractivePrepareResponse = {
  schema: "mathpilot.interactive-prepare/v1";
  frozen_input: JsonObject;
  workspace_projection: WorkspaceProjection;
};

const readJsonResponse = async (response: Response, operation: string): Promise<unknown> => {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAXIMUM_INTERACTIVE_PREPARE_RESPONSE_BYTES) throw new Error(`${operation} response is too large`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > MAXIMUM_INTERACTIVE_PREPARE_RESPONSE_BYTES) throw new Error(`${operation} response is too large`);
  if (!response.ok) throw new Error(`${operation} failed (${response.status})`);
  try { return JSON.parse(bytes.toString("utf8")) as unknown; }
  catch { throw new Error(`${operation} returned invalid JSON`); }
};

const parsePrepareResponse = (value: unknown): InteractivePrepareResponse => {
  const candidate = parseSharedInteractivePrepareResponse(value);
  return Object.freeze({
    schema: candidate.schema,
    frozen_input: Object.freeze(candidate.frozen_input as JsonObject),
    workspace_projection: parseWorkspaceProjection(candidate.workspace_projection),
  });
};

/**
 * Turn only already-materialized, canonical attachment objects into Pi image
 * input.  Browser-provided data URLs never enter this function.  Non-image
 * objects remain available at their projection path for model tools.
 */
export const buildPiImageInputs = async (input: {
  projectionRoot: string;
  canonicalMessage: CanonicalSyncMessage;
  objects: readonly ProjectionObject[];
}): Promise<readonly PiInputAttachment[]> => {
  const root = path.resolve(input.projectionRoot);
  const images: PiInputAttachment[] = [];
  let imageBytes = 0;
  for (const part of input.canonicalMessage.parts) {
    if (part.type !== "attachment") continue;
    const projection = input.objects.find((candidate) => descriptorMatchesAttachment(part, candidate.descriptor));
    if (!projection) throw new Error("interactive canonical attachment projection does not match the message");
    if (!part.mime_type.startsWith("image/")) continue;
    if (part.byte_size > CONTENT_POLICIES.thread.maximumStoredBytes - imageBytes) {
      throw new Error("interactive image projection exceeds the thread content policy");
    }
    imageBytes += part.byte_size;
    const target = path.resolve(root, projection.path);
    if (!target.startsWith(`${root}${path.sep}`)) throw new Error("interactive image projection escaped staging");
    const info = await lstat(target);
    if (!info.isFile()) throw new Error("interactive image projection is not a file");
    const bytes = await readFile(target);
    if (bytes.byteLength !== part.byte_size) throw new Error("interactive image bytes do not match the canonical descriptor");
    images.push({ type: "image", data: bytes.toString("base64"), mimeType: part.mime_type });
  }
  return images;
};

const makeReadOnly = async (root: string): Promise<void> => {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error("interactive projection may not contain symlinks");
    if (entry.isDirectory()) {
      await makeReadOnly(target);
      await chmod(target, 0o555);
    } else if (entry.isFile()) await chmod(target, 0o444);
    else throw new Error("interactive projection contains a non-file entry");
  }
  await chmod(root, 0o555);
};

const materializePrepareResponse = async (input: {
  workspace: string;
  prepared: InteractivePrepareResponse;
  canonicalMessage: CanonicalSyncMessage;
  actor: InternalActor;
  internalService: InternalServiceRuntime;
}): Promise<readonly PiInputAttachment[]> => {
  const projectionRoot = path.join(input.workspace, "input", "projection");
  const inputRoot = path.join(input.workspace, "input");
  const relativeProjection = path.relative(inputRoot, projectionRoot);
  if (relativeProjection !== "projection") throw new Error("interactive projection root escaped the workspace");
  const stateRoot = path.join(input.workspace, ".agent");
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  const nonce = randomUUID();
  const staging = path.join(stateRoot, `interactive-projection-${nonce}`);
  const previous = path.join(stateRoot, `interactive-previous-${nonce}`);
  let previousMoved = false;
  let published = false;
  await mkdir(staging, { recursive: false, mode: 0o700 });
  try {
    for (const file of input.prepared.workspace_projection.files) {
      const target = path.resolve(staging, file.path);
      if (!target.startsWith(`${staging}${path.sep}`)) throw new Error("interactive projection file escaped staging");
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, file.content, { encoding: "utf8", flag: "wx", mode: 0o400 });
    }
    for (const item of input.prepared.workspace_projection.objects) {
      const target = path.resolve(staging, item.path);
      if (!target.startsWith(`${staging}${path.sep}`)) throw new Error("interactive projection object escaped staging");
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    }
    if (input.prepared.workspace_projection.objects.length > 0) {
      await resolveAndMaterializeObjects({
        signal: AbortSignal.timeout(2 * 60_000),
        maximumAggregateBytes: CONTENT_POLICIES.thread.maximumStoredBytes,
        objects: input.prepared.workspace_projection.objects.map((item) => ({
          descriptor: item.descriptor,
          destination: path.resolve(staging, item.path),
        })),
        resolve: (objectRefs, signal) => input.internalService.request(
          "pi-to-storage",
          input.actor,
          "/internal/objects/resolve",
          {
            method: "POST",
            json: storageObjectResolveRequestSchema.parse({ object_refs: objectRefs, download_intent: "attachment" }),
            signal,
            timeoutMs: 30_000,
          },
        ),
      });
    }

    const images = await buildPiImageInputs({
      projectionRoot: staging,
      canonicalMessage: input.canonicalMessage,
      objects: input.prepared.workspace_projection.objects,
    });
    await writeFile(
      path.join(staging, "manifest.json"),
      `${canonicalJson(input.prepared.workspace_projection.manifest).json}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o400 },
    );
    await makeReadOnly(staging);
    try {
      const info = await lstat(projectionRoot);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("interactive projection root must be a directory");
      await rename(projectionRoot, previous);
      previousMoved = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await rename(staging, projectionRoot);
    published = true;
    if (previousMoved) {
      await rm(previous, { recursive: true, force: true });
      previousMoved = false;
    }
    const frozenPath = path.join(input.workspace, "input", "frozen", "interactive-epoch.json");
    await mkdir(path.dirname(frozenPath), { recursive: true });
    await writeFile(frozenPath, `${canonicalJson(input.prepared.frozen_input).json}\n`, { encoding: "utf8", mode: 0o400 });
    await chmod(frozenPath, 0o400);
    return images;
  } finally {
    if (!published) await rm(staging, { recursive: true, force: true });
    if (!published && previousMoved) await rename(previous, projectionRoot).catch(() => undefined);
  }
};

export type InteractivePublicPart =
  | { type: "text"; text: string }
  | { type: "teaching_artifact"; artifact_ref: string; artifact_schema: string; summary: string };

export class PiInteractiveLearningBridge {
  constructor(private readonly internalService: InternalServiceRuntime) {}

  async prepare(
    actor: InternalActor,
    receiptValue: unknown,
    workspace: string,
    canonicalMessage: CanonicalSyncMessage,
  ): Promise<{ receipt: InteractiveAdmissionReceipt; images: readonly PiInputAttachment[] }> {
    const receipt = parseInteractiveAdmissionReceipt(receiptValue);
    const response = await this.internalService.request(
      "pi-to-learning",
      actor,
      `/internal/interactive/attempts/${encodeURIComponent(receipt.agent_attempt_id)}/prepare`,
      { method: "POST", json: interactiveReceiptBinding(receipt), timeoutMs: 2 * 60_000 },
    );
    const prepared = parsePrepareResponse(await readJsonResponse(response, "interactive prepare"));
    const images = await materializePrepareResponse({
      workspace, prepared, canonicalMessage, actor, internalService: this.internalService,
    });
    return { receipt, images };
  }

  async complete(actor: InternalActor, receiptValue: unknown, result: {
    output: JsonObject;
    resolvedModelId: string;
    inputTokens: number;
    outputTokens: number;
  }): Promise<void> {
    const receipt = parseInteractiveAdmissionReceipt(receiptValue);
    const response = await this.internalService.request(
      "pi-to-learning",
      actor,
      `/internal/interactive/attempts/${encodeURIComponent(receipt.agent_attempt_id)}/complete`,
      {
        method: "POST",
        json: {
          ...interactiveReceiptBinding(receipt), event_id: receipt.event_id, output: result.output,
          resolved_model_id: result.resolvedModelId,
          input_tokens: result.inputTokens, output_tokens: result.outputTokens,
        },
        timeoutMs: 2 * 60_000,
      },
    );
    if (!response.ok) throw new Error(`interactive completion failed (${response.status})`);
    await response.body?.cancel().catch(() => undefined);
  }

  async terminal(actor: InternalActor, receiptValue: unknown, result: {
    status: "failed" | "cancelled";
    errorCode: string;
    errorDetail: string;
  }): Promise<void> {
    const receipt = parseInteractiveAdmissionReceipt(receiptValue);
    const response = await this.internalService.request(
      "pi-to-learning",
      actor,
      `/internal/interactive/attempts/${encodeURIComponent(receipt.agent_attempt_id)}/terminal`,
      {
        method: "POST",
        json: {
          ...interactiveReceiptBinding(receipt), status: result.status,
          error_code: result.errorCode, error_detail: result.errorDetail.slice(0, 2_000),
        },
        timeoutMs: 2 * 60_000,
      },
    );
    if (!response.ok) throw new Error(`interactive terminal callback failed (${response.status})`);
    await response.body?.cancel().catch(() => undefined);
  }
}
