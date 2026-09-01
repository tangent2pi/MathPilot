import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { S3ServiceException } from "@aws-sdk/client-s3";
import {
  canonicalObjectReference,
  contentPolicy,
  parseObjectReference,
  storagePublicationRequestSchema,
  storageObjectResolveRequestSchema,
  uploadPurposeSchema,
  type ImmutableObjectDescriptor,
  type StorageObjectDownloadIntent,
  type StorageObjectPurpose,
  type UploadPurpose,
} from "@mathpilot/content-integrity";
import { ContentIntegrityError, sealContent, type SealedContent } from "@mathpilot/content-integrity/node";
import type { InternalServiceRuntime } from "@mathpilot/internal-service";
import { internalServiceContext, internalServiceGuard, type ProblemInput } from "@mathpilot/internal-service/fastify";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { BucketName, DataPlaneAudience, ObjectStore } from "./object-store.ts";
import { newId, type Principal } from "./lib.ts";

const WRITE_EDGES = ["api-to-storage", "pi-to-storage"] as const;
const READ_EDGES = ["api-to-storage", "pi-to-storage", "learning-to-storage"] as const;
const MAX_VERIFICATION_ATTEMPTS = 16;

type StorageEdge = "api-to-storage" | "pi-to-storage" | "learning-to-storage";
type StorageOperation = "init" | "complete" | "delete" | "resolve";

const EDGE_PURPOSE_POLICY = Object.freeze({
  "api-to-storage": Object.freeze({
    init: Object.freeze(["thread", "avatar"] as const),
    complete: Object.freeze(["thread", "avatar"] as const),
    delete: Object.freeze(["thread", "avatar"] as const),
    resolve: Object.freeze(["thread", "avatar"] as const),
  }),
  "pi-to-storage": Object.freeze({
    init: Object.freeze(["candidate"] as const),
    complete: Object.freeze(["candidate"] as const),
    delete: Object.freeze(["candidate"] as const),
    resolve: Object.freeze(["source", "thread"] as const),
  }),
  "learning-to-storage": Object.freeze({
    init: Object.freeze([] as const),
    complete: Object.freeze([] as const),
    delete: Object.freeze([] as const),
    resolve: Object.freeze(["thread"] as const),
  }),
} satisfies Record<StorageEdge, Record<StorageOperation, readonly StorageObjectPurpose[]>>);

function purposesFor(edge: string, operation: StorageOperation): readonly StorageObjectPurpose[] {
  return EDGE_PURPOSE_POLICY[edge as StorageEdge]?.[operation] ?? [];
}

function assertPurposeAllowed(edge: string, operation: StorageOperation, purpose: StorageObjectPurpose): void {
  if (!purposesFor(edge, operation).includes(purpose)) {
    throw new StorageRouteError(403, "purpose_not_allowed", "this service edge cannot perform that object operation");
  }
}

export interface StorageQueryClient {
  query<Row>(text: string, values?: readonly unknown[]): Promise<{ rows: Row[] }>;
}

export type RunWithPrincipal = <T>(
  principal: Principal,
  operation: (client: StorageQueryClient) => Promise<T>,
) => Promise<T>;

export type StorageObjectOperations = Pick<ObjectStore,
  "createUploadPolicy" | "statSource" | "openSource" |
  "putCanonical" | "removeVersion" | "presignedDownload"
>;

export interface StorageRouteDependencies {
  identity: InternalServiceRuntime;
  objects: StorageObjectOperations;
  runWithPrincipal: RunWithPrincipal;
}

class StorageRouteError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) { super(message); }
}

interface ObjectRow {
  object_id: string;
  tenant_id: string;
  owner_user_id: string;
  bucket_name: BucketName;
  object_key: string;
  source_object_key: string;
  declared_byte_size: number | string;
  declared_mime_type: string;
  original_name: string;
  purpose: StorageObjectPurpose;
  state: "pending" | "verifying" | "ready" | "failed" | "deleting" | "deleted";
  version_id: string | null;
  etag: string | null;
  sha256: string | null;
  byte_size: number | string | null;
  mime_type: string | null;
  source_version_id: string | null;
  source_etag: string | null;
  source_sha256: string | null;
  source_byte_size: number | string | null;
  source_mime_type: string | null;
  expires_at: Date | string | null;
  verification_lease_id: string | null;
  verification_started_at: Date | string | null;
  verification_attempts: number;
}

const asDate = (value: Date | string): Date => value instanceof Date ? value : new Date(value);
const iso = (value: Date | string | null): string | null => value === null ? null : asDate(value).toISOString();

function descriptor(row: ObjectRow): ImmutableObjectDescriptor {
  if (!row.version_id || !row.sha256 || row.byte_size === null || !row.mime_type
    || !row.source_version_id || !row.source_sha256 || row.source_byte_size === null || !row.source_mime_type) {
    throw new StorageRouteError(500, "invalid_ready_object", "ready object is missing immutable provenance");
  }
  return Object.freeze({
    object_id: row.object_id,
    object_ref: canonicalObjectReference(row.object_id),
    version_id: row.version_id,
    sha256: row.sha256,
    byte_size: Number(row.byte_size),
    mime_type: row.mime_type,
    original_name: row.original_name,
    source: Object.freeze({
      version_id: row.source_version_id,
      sha256: row.source_sha256,
      byte_size: Number(row.source_byte_size),
      mime_type: row.source_mime_type,
    }),
    expires_at: iso(row.expires_at),
  });
}

function bucketForPurpose(purpose: UploadPurpose): BucketName {
  return purpose === "candidate" ? "mathpilot-working" : "mathpilot-session";
}

function contextOf(request: FastifyRequest): { principal: Principal; audience: DataPlaneAudience; edge: string } {
  const context = internalServiceContext(request);
  return {
    principal: context.actor,
    audience: context.edge === "api-to-storage" ? "public" : "internal",
    edge: context.edge,
  };
}

function validateInit(request: FastifyRequest): {
  purpose: UploadPurpose; mimeType: string; byteSize: number; originalName: string;
} {
  const parsed = storagePublicationRequestSchema.safeParse(request.body);
  if (!parsed.success) {
    throw new StorageRouteError(422, "object_policy_rejected", "object declaration violates its content policy");
  }
  assertPurposeAllowed(internalServiceContext(request).edge, "init", parsed.data.purpose);
  return {
    purpose: parsed.data.purpose,
    mimeType: parsed.data.mime_type,
    byteSize: parsed.data.byte_size,
    originalName: parsed.data.original_name,
  };
}

function assertDownloadIntentAllowed(row: ObjectRow, intent: StorageObjectDownloadIntent): void {
  if (intent === "inline" && row.mime_type !== "image/webp") {
    throw new StorageRouteError(422, "object_not_inline_safe", "only canonical safe images may be displayed inline");
  }
}

const queryObject = async (client: StorageQueryClient, objectId: string): Promise<ObjectRow | undefined> =>
  (await client.query<ObjectRow>(
    `select object_id,tenant_id,owner_user_id,bucket_name,object_key,source_object_key,
            declared_byte_size,declared_mime_type,original_name,purpose,state,
            version_id,etag,sha256,byte_size,mime_type,source_version_id,source_etag,
            source_sha256,source_byte_size,source_mime_type,expires_at,
            verification_lease_id,verification_started_at,verification_attempts
       from storage_object where object_id=$1`, [objectId],
  )).rows[0];

const requestAbortSignal = (
  request: FastifyRequest,
  reply: FastifyReply,
): { signal: AbortSignal; release(): void } => {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) {
      controller.abort(new DOMException("storage request was aborted", "AbortError"));
    }
  };
  const responseClosed = () => {
    if (!reply.raw.writableFinished) abort();
  };
  if (request.raw.aborted) abort();
  else {
    request.raw.once("aborted", abort);
    reply.raw.once("close", responseClosed);
  }
  return {
    signal: controller.signal,
    release() {
      request.raw.removeListener("aborted", abort);
      reply.raw.removeListener("close", responseClosed);
    },
  };
};

function mapStorageError(error: unknown): StorageRouteError {
  if (error instanceof StorageRouteError) return error;
  if (error instanceof ContentIntegrityError) {
    return error.disposition === "terminal"
      ? new StorageRouteError(422, error.code, error.message)
      : new StorageRouteError(500, error.code, "content verification is temporarily unavailable");
  }
  if (error instanceof Error && error.name === "AbortError") return new StorageRouteError(408, "verification_cancelled", "object verification was cancelled");
  if (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404) {
    return new StorageRouteError(404, "object_bytes_not_found", "uploaded object bytes were not found");
  }
  return new StorageRouteError(500, "storage_operation_failed", "storage operation failed");
}

export function storageProblemFromError(error: unknown): ProblemInput {
  const mapped = mapStorageError(error);
  return {
    status: mapped.statusCode,
    code: mapped.code,
    title: mapped.statusCode >= 500 ? "Storage operation failed" : mapped.message,
  };
}

export function registerStorageRoutes(server: FastifyInstance, dependencies: StorageRouteDependencies): void {
  const { identity, objects, runWithPrincipal } = dependencies;

  server.post("/internal/objects/init", { preHandler: internalServiceGuard(identity, WRITE_EDGES) }, async (request, reply) => {
    const { principal, audience } = contextOf(request);
    const declaration = validateInit(request);
    const objectId = newId("obj");
    const bucket = bucketForPurpose(declaration.purpose);
    const sourceKey = `quarantine/${principal.tenantId}/${declaration.purpose}/${objectId}/source`;
    const objectKey = `objects/${principal.tenantId}/${declaration.purpose}/${objectId}/content`;
    const uploadExpiresAt = new Date(Date.now()+5*60_000);
    await runWithPrincipal(principal, (client) => client.query(
      `insert into storage_object(
         object_id,tenant_id,bucket_name,object_key,source_object_key,
         declared_byte_size,declared_mime_type,original_name,owner_user_id,purpose,state,expires_at
       ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',$11)`,
      [objectId,principal.tenantId,bucket,objectKey,sourceKey,declaration.byteSize,
       declaration.mimeType,declaration.originalName,principal.userId,declaration.purpose,
       new Date(uploadExpiresAt.getTime()+10*60_000)],
    ));
    const cancellation = requestAbortSignal(request, reply);
    try {
      const upload = await objects.createUploadPolicy({
        audience,bucket,key:sourceKey,mimeType:declaration.mimeType,byteSize:declaration.byteSize,
        expiresAt:uploadExpiresAt,objectId,
      }, cancellation.signal);
      return reply.code(201).send({
        object_id: objectId, expires_at: uploadExpiresAt.toISOString(),
        upload: { method: "POST", url: upload.url, fields: upload.fields },
      });
    } catch (error) {
      await runWithPrincipal(principal, (client) => client.query(
        `update storage_object set state='failed',last_failure_code='upload_policy_failed',
                last_failure_at=clock_timestamp(),expires_at=clock_timestamp()
          where object_id=$1 and state='pending'`, [objectId],
      )).catch(() => undefined);
      throw error;
    } finally {
      cancellation.release();
    }
  });

  server.post("/internal/objects/:id/complete", { preHandler: internalServiceGuard(identity, WRITE_EDGES) }, async (request, reply) => {
    const { principal, edge } = contextOf(request);
    const objectId = (request.params as { id: string }).id;
    const leaseId = randomUUID();
    const acquired = await runWithPrincipal(principal, async (client) => {
      const current = await queryObject(client, objectId);
      if (!current) throw new StorageRouteError(404,"object_not_found","object not found");
      assertPurposeAllowed(edge, "complete", current.purpose);
      if (current.expires_at && asDate(current.expires_at).getTime()<=Date.now()) {
        throw new StorageRouteError(410,"object_expired","object upload expired");
      }
      if (current.state === "ready") return { row: current, ready: true } as const;
      if (current.state === "failed" || current.state === "deleting" || current.state === "deleted") {
        throw new StorageRouteError(410,"object_terminal","object is no longer completable");
      }
      if (current.verification_attempts>=MAX_VERIFICATION_ATTEMPTS) {
        throw new StorageRouteError(410,"verification_attempts_exhausted","object verification attempts are exhausted");
      }
      const stale = current.state === "verifying" && current.verification_started_at
        && asDate(current.verification_started_at).getTime()<=Date.now()-10*60_000;
      if (current.state === "verifying" && !stale) {
        throw new StorageRouteError(409,"verification_in_progress","object verification is already in progress");
      }
      const claimed = (await client.query<ObjectRow>(
        `update storage_object set state='verifying',verification_lease_id=$2,
                verification_started_at=clock_timestamp(),verification_attempts=verification_attempts+1,
                expires_at=clock_timestamp()+interval '15 minutes'
          where object_id=$1 and purpose=any($3::text[])
            and expires_at>clock_timestamp() and verification_attempts<$4
            and (
              state='pending'
              or (state='verifying' and verification_started_at<=clock_timestamp()-interval '10 minutes')
            )
          returning object_id,tenant_id,owner_user_id,bucket_name,object_key,source_object_key,
            declared_byte_size,declared_mime_type,original_name,purpose,state,
            version_id,etag,sha256,byte_size,mime_type,source_version_id,source_etag,
            source_sha256,source_byte_size,source_mime_type,expires_at,
            verification_lease_id,verification_started_at,verification_attempts`,
          [objectId,leaseId,purposesFor(edge,"complete"),MAX_VERIFICATION_ATTEMPTS],
      )).rows[0];
      if (!claimed) throw new StorageRouteError(409,"verification_race","object verification lease was not acquired");
      return { row: claimed, ready: false } as const;
    });
    if (acquired.ready) return descriptor(acquired.row);

    const cancellation = requestAbortSignal(request, reply);
    let sealed: SealedContent | undefined;
    let canonical: { versionId: string; etag: string } | undefined;
    let published = false;
    let sourceVersion = acquired.row.source_version_id;
    let sourceEtag = acquired.row.source_etag;
    const startedAt = Date.now();
    request.log.info({ objectId,leaseId,attempt:acquired.row.verification_attempts }, "object verification started");
    try {
      if (!sourceVersion) {
        const sourceStat = await objects.statSource(
          acquired.row.bucket_name,
          acquired.row.source_object_key,
          undefined,
          cancellation.signal,
        );
        if (sourceStat.size!==Number(acquired.row.declared_byte_size)) {
          throw new ContentIntegrityError("content_size_mismatch","uploaded object size does not match its declaration");
        }
        sourceVersion = sourceStat.versionId!;
        sourceEtag = sourceStat.etag;
        const frozen = await runWithPrincipal(principal, (client) => client.query(
          `update storage_object set source_version_id=$3,source_etag=$4
            where object_id=$1 and state='verifying' and verification_lease_id=$2
            returning object_id`, [objectId,leaseId,sourceVersion,sourceEtag],
        ));
        if (!frozen.rows[0]) throw new StorageRouteError(409,"verification_lease_lost","object verification lease was lost");
      }
      const source = await objects.openSource(
        acquired.row.bucket_name,
        acquired.row.source_object_key,
        sourceVersion,
        cancellation.signal,
      );
      sealed = await sealContent(source,contentPolicy(uploadPurposeSchema.parse(acquired.row.purpose)),{
        declaredMimeType: acquired.row.declared_mime_type,
        expectedBytes: Number(acquired.row.declared_byte_size),signal:cancellation.signal,
      });
      const canonicalStream = sealed.openStored() as Readable;
      const abortCanonical = () => canonicalStream.destroy(Object.assign(new Error("object publication aborted"), { name:"AbortError" }));
      if (cancellation.signal.aborted) abortCanonical();
      else cancellation.signal.addEventListener("abort",abortCanonical,{ once:true });
      try {
        canonical = await objects.putCanonical({
          bucket:acquired.row.bucket_name,key:acquired.row.object_key,
          stream:canonicalStream,byteSize:sealed.stored.byteSize,
          mimeType:sealed.stored.mimeType,sha256:sealed.stored.sha256,objectId,
        }, cancellation.signal);
      } finally {
        cancellation.signal.removeEventListener("abort",abortCanonical);
      }
      const finalized = await runWithPrincipal(principal, async (client) => {
        const updated = (await client.query<ObjectRow>(
          `update storage_object set state='ready',version_id=$3,etag=$4,sha256=$5,
                  byte_size=$6,mime_type=$7,source_version_id=$8,source_etag=$9,
                  source_sha256=$10,source_byte_size=$11,source_mime_type=$12,
                  verified_at=clock_timestamp(),verification_lease_id=null,
                  expires_at=clock_timestamp()+interval '24 hours',last_failure_code=null,last_failure_at=null
            where object_id=$1 and state='verifying' and verification_lease_id=$2
            returning object_id,tenant_id,owner_user_id,bucket_name,object_key,source_object_key,
              declared_byte_size,declared_mime_type,original_name,purpose,state,
              version_id,etag,sha256,byte_size,mime_type,source_version_id,source_etag,
              source_sha256,source_byte_size,source_mime_type,expires_at,
              verification_lease_id,verification_started_at,verification_attempts`,
          [objectId,leaseId,canonical!.versionId,canonical!.etag,sealed!.stored.sha256,
           sealed!.stored.byteSize,sealed!.stored.mimeType,sourceVersion,sourceEtag,
           sealed!.source.sha256,sealed!.source.byteSize,sealed!.source.mimeType],
        )).rows[0];
        if (!updated) throw new StorageRouteError(409,"verification_lease_lost","object verification lease was lost");
        return updated;
      });
      published = true;
      await objects.removeVersion(
        acquired.row.bucket_name,
        acquired.row.source_object_key,
        sourceVersion,
        cancellation.signal,
      )
        .catch((error) => request.log.warn({ err:error,objectId,sourceVersion },"verified quarantine version awaits lifecycle cleanup"));
      request.log.info({ objectId,durationMs:Date.now()-startedAt,byteSize:sealed.stored.byteSize },"object verification completed");
      return descriptor(finalized);
    } catch (error) {
      const mapped = mapStorageError(error);
      const terminal = error instanceof ContentIntegrityError
        ? error.disposition === "terminal"
        : acquired.row.verification_attempts>=3;
      await runWithPrincipal(principal, (client) => client.query(
        `update storage_object set state=$3,verification_lease_id=null,
                last_failure_code=$4,last_failure_at=clock_timestamp(),
                expires_at=clock_timestamp()+case when $3='failed' then interval '1 hour' else interval '15 minutes' end
          where object_id=$1 and state='verifying' and verification_lease_id=$2`,
        [objectId,leaseId,terminal?"failed":"pending",mapped.code],
      )).catch(() => undefined);
      request.log.warn({ err:error,objectId,code:mapped.code,terminal },"object verification failed");
      throw mapped;
    } finally {
      cancellation.release();
      await sealed?.cleanup().catch(() => undefined);
      if (canonical && !published) {
        await objects.removeVersion(
          acquired.row.bucket_name,
          acquired.row.object_key,
          canonical.versionId,
          new AbortController().signal,
        ).catch(() => undefined);
      }
    }
  });

  server.post("/internal/objects/resolve", { preHandler: internalServiceGuard(identity, READ_EDGES) }, async (request, reply) => {
    const { principal, audience, edge } = contextOf(request);
    const body = storageObjectResolveRequestSchema.safeParse(request.body);
    if (!body.success) throw new StorageRouteError(422,"invalid_object_refs","object_refs must be a unique bounded list");
    const cancellation = requestAbortSignal(request, reply);
    try {
      const ids = body.data.object_refs.map((value) => parseObjectReference(value)!);
      const rows = await runWithPrincipal(principal, async (client) => (await client.query<ObjectRow>(
        `select object_id,tenant_id,owner_user_id,bucket_name,object_key,source_object_key,
                declared_byte_size,declared_mime_type,original_name,purpose,state,
                version_id,etag,sha256,byte_size,mime_type,source_version_id,source_etag,
                source_sha256,source_byte_size,source_mime_type,expires_at,
                verification_lease_id,verification_started_at,verification_attempts
           from storage_object where object_id=any($1::text[]) and purpose=any($2::text[]) and state='ready'
            and (expires_at is null or expires_at>clock_timestamp())`, [ids,purposesFor(edge,"resolve")],
      )).rows);
      if (rows.length!==ids.length) throw new StorageRouteError(404,"object_not_found","one or more objects were not found");
      const byId = new Map(rows.map((row) => [row.object_id,row]));
      const expiresAt = new Date(Date.now()+5*60_000).toISOString();
      const resolved = await Promise.all(ids.map(async (id) => {
        const row = byId.get(id)!;
        assertPurposeAllowed(edge,"resolve",row.purpose);
        const value = descriptor(row);
        assertDownloadIntentAllowed(row, body.data.download_intent);
        const url = await objects.presignedDownload({ audience,bucket:row.bucket_name,key:row.object_key,
          versionId:value.version_id,expiresSeconds:300,mimeType:value.mime_type,originalName:value.original_name,
          intent:body.data.download_intent },
        cancellation.signal);
        return { ...value,download:{ url,expires_at:expiresAt } };
      }));
      return { objects:resolved };
    } finally {
      cancellation.release();
    }
  });

  server.delete("/internal/objects/:id", { preHandler: internalServiceGuard(identity, WRITE_EDGES) }, async (request,reply) => {
    const { principal, edge } = contextOf(request);
    const objectId = (request.params as { id:string }).id;
    const deletion = await runWithPrincipal(principal, (client) => client.query<{ accepted:boolean }>(
      `select mathpilot_storage_request_owned_deletion($1,$2,$3,$4::text[]) as accepted`,
      [principal.tenantId,principal.userId,objectId,purposesFor(edge,"delete")],
    ));
    if (!deletion.rows[0]?.accepted) {
      throw new StorageRouteError(404,"object_not_found","object not found or already retained");
    }
    return reply.code(202).send({ object_id:objectId,state:"deleting" });
  });
}
