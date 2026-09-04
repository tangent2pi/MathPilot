import type { FastifyInstance, FastifyRequest } from "fastify";
import type { InternalServiceRuntime } from "@mathpilot/internal-service";
import { internalServiceContext, internalServiceGuard } from "@mathpilot/internal-service/fastify";
import type { BucketName } from "./object-store.ts";
import { finiteInteger, newId, stringValue, type Principal } from "./lib.ts";

const PURPOSES = new Set(["source", "candidate", "package", "thread", "derived", "paper"]);
const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*(?:\s*;.*)?$/i;
const WRITE_EDGES = ["api-to-storage", "pi-to-storage", "content-to-storage"] as const;
const READ_EDGES = ["api-to-storage", "pi-to-storage", "learning-to-storage", "content-to-storage"] as const;

export interface StorageQueryClient {
  query<Row>(text: string, values?: readonly unknown[]): Promise<{ rows: Row[] }>;
}

export type RunWithPrincipal = <T>(
  principal: Principal,
  operation: (client: StorageQueryClient) => Promise<T>,
) => Promise<T>;

export interface StorageObjectOperations {
  readonly publicOrigin: string;
  presignedPut(bucket: BucketName, key: string, expiresSeconds: number): Promise<string>;
  presignedInternalPut(bucket: BucketName, key: string, expiresSeconds: number): Promise<string>;
  presignedGet(bucket: BucketName, key: string, expiresSeconds: number, versionId?: string | null): Promise<string>;
  presignedInternalGet(bucket: BucketName, key: string, expiresSeconds: number, versionId?: string | null): Promise<string>;
  verify(bucket: BucketName, key: string, expectedSize: number, expectedMime: string): Promise<{
    stat: { etag?: string | null; versionId?: string | null };
    sha256: string;
  }>;
}

export interface StorageRouteDependencies {
  identity: InternalServiceRuntime;
  objects: StorageObjectOperations;
  runWithPrincipal: RunWithPrincipal;
}

function bucketForPurpose(purpose: string): BucketName {
  if (purpose === "source" || purpose === "package") return "mathpilot-content";
  if (purpose === "thread") return "mathpilot-session";
  return "mathpilot-working";
}

function safeName(value: string): string {
  const basename = value.replaceAll("\\", "/").split("/").pop() ?? "object";
  const safe = basename.replace(/[^\p{L}\p{N}._-]+/gu, "_").replace(/^\.+$/, "");
  return (safe || "object").slice(0, 180);
}

function principalOf(request: FastifyRequest): Principal {
  return internalServiceContext(request).actor;
}

function authorizeObject(row: { tenant_id: string; owner_user_id: string | null }, principal: Principal): boolean {
  // A role is not a blanket file grant. Current user-facing object flows are
  // owner-private; a future shared package object must carry an explicit
  // content grant rather than making every teacher a tenant-wide file reader.
  return row.tenant_id === principal.tenantId && row.owner_user_id === principal.userId;
}

export function registerStorageRoutes(server: FastifyInstance, dependencies: StorageRouteDependencies): void {
  const { identity, objects, runWithPrincipal } = dependencies;

  server.setErrorHandler((error, request, reply) => {
    request.log.error({ err: error }, "storage-next request failed");
    const candidateStatus = typeof error === "object" && error !== null && "statusCode" in error
      ? (error as { statusCode?: unknown }).statusCode
      : undefined;
    const statusCode = typeof candidateStatus === "number" && candidateStatus >= 400 && candidateStatus < 500
      ? candidateStatus
      : 500;
    return reply.code(statusCode).send({ error: statusCode === 500 ? "storage-next request failed" : (error instanceof Error ? error.message : "invalid storage request") });
  });

  server.post(
    "/internal/objects/init",
    { preHandler: internalServiceGuard(identity, WRITE_EDGES) },
    async (request, reply) => {
      const principal = principalOf(request);
      const body = (request.body ?? {}) as Record<string, unknown>;
      const purpose = stringValue(body.purpose);
      const mimeType = stringValue(body.mime_type).split(";", 1)[0]!.toLowerCase();
      const byteSize = finiteInteger(body.byte_size, -1);
      const originalName = stringValue(body.original_name, "object");
      if (!PURPOSES.has(purpose) || !MIME.test(mimeType) || byteSize < 1 || byteSize > 256 * 1024 * 1024 || originalName.length > 255) return reply.code(422).send({ error: "invalid object metadata" });
      const objectId = newId("obj");
      const bucket = bucketForPurpose(purpose);
      const key = `${purpose}/${objectId}/${safeName(originalName)}`;
      await runWithPrincipal(principal, async (client) => {
        await client.query(
          `insert into storage_object(object_id,tenant_id,bucket_name,object_key,byte_size,mime_type,original_name,owner_user_id,purpose)
           values($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [objectId, principal.tenantId, bucket, key, byteSize, mimeType, originalName, principal.userId, purpose],
        );
      });
      // Audience is part of the assertion-bound JSON body. Missing or unknown
      // values retain the public default used by browser upload initialization.
      const audience = body.audience === "runtime" ? "runtime" : "public";
      const uploadUrl = audience === "runtime"
        ? await objects.presignedInternalPut(bucket, key, 300)
        : await objects.presignedPut(bucket, key, 300);
      return { object_id: objectId, bucket_name: bucket, object_key: key, upload_url: uploadUrl, expires_in: 300, public_origin: objects.publicOrigin };
    },
  );

  server.post(
    "/internal/objects/:id/complete",
    { preHandler: internalServiceGuard(identity, WRITE_EDGES) },
    async (request) => {
      const principal = principalOf(request);
      const objectId = (request.params as { id: string }).id;
      const result = await runWithPrincipal(principal, async (client) => {
        const row = (await client.query<{ object_id: string; tenant_id: string; owner_user_id: string | null; bucket_name: BucketName; object_key: string; byte_size: number; mime_type: string; state: string; sha256: string | null; version_id: string | null; etag: string | null }>(
          `select object_id,tenant_id,owner_user_id,bucket_name,object_key,byte_size,mime_type,state,sha256,version_id,etag from storage_object where object_id=$1`, [objectId],
        )).rows[0];
        if (!row || !authorizeObject(row, principal)) throw new Error("object not found");
        if (row.state !== "pending") return { object_id: row.object_id, state: row.state, sha256: row.sha256, version_id: row.version_id, etag: row.etag };
        const verified = await objects.verify(row.bucket_name, row.object_key, Number(row.byte_size), row.mime_type);
        const sha256 = verified.sha256;
        const claimed = stringValue(((request.body ?? {}) as Record<string, unknown>).sha256);
        if (claimed && claimed !== sha256) throw new Error("client hash does not match object bytes");
        await client.query(
          `update storage_object set sha256=$2,etag=$3,version_id=$4,state='ready',verified_at=now() where object_id=$1`,
          [objectId, sha256, verified.stat.etag ?? null, verified.stat.versionId ?? null],
        );
        return { object_id: objectId, state: "ready", sha256, version_id: verified.stat.versionId ?? null, etag: verified.stat.etag ?? null };
      }).catch((error) => {
        if (error instanceof Error && (error.message === "object not found" || /key does not exist|not found/i.test(error.message))) throw Object.assign(new Error("object not found"), { statusCode: 404 });
        throw error;
      });
      return result;
    },
  );

  server.post(
    "/internal/objects/:id/presign-get",
    { preHandler: internalServiceGuard(identity, READ_EDGES) },
    async (request) => {
      const principal = principalOf(request);
      const objectId = (request.params as { id: string }).id;
      const result = await runWithPrincipal(principal, async (client) => {
        const row = (await client.query<{ object_id: string; tenant_id: string; owner_user_id: string | null; bucket_name: BucketName; object_key: string; state: string; original_name: string | null; mime_type: string; byte_size: number; sha256: string | null; version_id: string | null; etag: string | null }>(
          `select object_id,tenant_id,owner_user_id,bucket_name,object_key,state,original_name,mime_type,byte_size,sha256,version_id,etag from storage_object where object_id=$1`, [objectId],
        )).rows[0];
        if (!row || !authorizeObject(row, principal) || row.state !== "ready") throw new Error("object not found");
        const body = (request.body ?? {}) as Record<string, unknown>;
        const audience = body.audience === "runtime" ? "runtime" : "public";
        const url = audience === "runtime"
          ? await objects.presignedInternalGet(row.bucket_name, row.object_key, 300, row.version_id)
          : await objects.presignedGet(row.bucket_name, row.object_key, 300, row.version_id);
        return {
          object_id: row.object_id,
          download_url: url,
          expires_in: 300,
          public_origin: objects.publicOrigin,
          original_name: row.original_name,
          mime_type: row.mime_type,
          byte_size: Number(row.byte_size),
          sha256: row.sha256,
          version_id: row.version_id,
          etag: row.etag,
        };
      }).catch((error) => {
        if (error instanceof Error && error.message === "object not found") throw Object.assign(new Error("object not found"), { statusCode: 404 });
        throw error;
      });
      return result;
    },
  );
}
