import { Readable } from "node:stream";
import { basename, parse, win32 } from "node:path";
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutBucketLifecycleConfigurationCommand,
  PutBucketVersioningCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import type { StorageObjectDownloadIntent } from "@mathpilot/content-integrity";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import contentDisposition from "content-disposition";
import { extension } from "mime-types";

export const BUCKETS = ["mathpilot-content", "mathpilot-working", "mathpilot-session"] as const;
export type BucketName = (typeof BUCKETS)[number];
export type DataPlaneAudience = "public" | "internal";

function canonicalDownloadName(originalName: string, mimeType: string): string {
  if (mimeType !== "image/webp") return originalName;
  const canonicalExtension = extension(mimeType);
  if (!canonicalExtension) throw new Error(`no filename extension is registered for ${mimeType}`);
  const leaf = win32.basename(basename(originalName));
  const stem = parse(leaf).name || "object";
  return `${stem}.${canonicalExtension}`;
}

export function objectContentDisposition(
  intent: StorageObjectDownloadIntent,
  originalName: string,
  mimeType: string,
): string {
  return contentDisposition(canonicalDownloadName(originalName, mimeType), { type: intent });
}

export interface ObjectStoreConfiguration {
  readonly endpoint: string;
  readonly publicEndpoint: string;
  readonly accessKey: string;
  readonly secretKey: string;
  readonly region: string;
  readonly connectionTimeoutMs: number;
  readonly requestTimeoutMs: number;
  readonly socketTimeoutMs: number;
  readonly maxAttempts: number;
}

interface Endpoint {
  readonly client: S3Client;
}

function endpoint(value: string, config: ObjectStoreConfiguration): Endpoint {
  const parsed = new URL(value.includes("://") ? value : `http://${value}`);
  if (!parsed.hostname) throw new Error("S3 endpoint host is required");
  if (parsed.username || parsed.password) throw new Error("S3 endpoint must not contain credentials");

  const clientConfig: S3ClientConfig = {
    endpoint: parsed.toString(),
    forcePathStyle: true,
    region: config.region,
    credentials: { accessKeyId: config.accessKey, secretAccessKey: config.secretKey },
    maxAttempts: config.maxAttempts,
    requestHandler: new NodeHttpHandler({
      connectionTimeout: config.connectionTimeoutMs,
      requestTimeout: config.requestTimeoutMs,
      socketTimeout: config.socketTimeoutMs,
      throwOnRequestTimeout: true,
    }),
  };
  return { client: new S3Client(clientConfig) };
}

function abortIfRequested(signal: AbortSignal): void {
  signal.throwIfAborted();
}

function isMissingBucket(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  return value.$metadata?.httpStatusCode === 404
    || value.name === "NotFound"
    || value.name === "NoSuchBucket";
}

function requiredVersionId(value: string | undefined, operation: string): string {
  if (!value) throw new Error(`S3 did not return an immutable ${operation} version`);
  return value;
}

function requiredEtag(value: string | undefined, operation: string): string {
  if (!value) throw new Error(`S3 did not return an ${operation} ETag`);
  return value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
}

function nodeReadable(body: unknown): Readable {
  if (body instanceof Readable) return body;
  if (body && typeof body === "object" && "transformToWebStream" in body
    && typeof body.transformToWebStream === "function") {
    const webStream = body.transformToWebStream();
    return Readable.fromWeb(webStream as Parameters<typeof Readable.fromWeb>[0]);
  }
  throw new Error("S3 GetObject did not return a Node-readable body");
}

export interface UploadPostPolicy {
  readonly url: string;
  readonly fields: Readonly<Record<string, string>>;
}

export interface SourceObjectStat {
  readonly size: number;
  readonly etag: string;
  readonly versionId: string;
  readonly lastModified?: Date;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface StoredVersion {
  readonly etag: string;
  readonly versionId: string;
}

export class ObjectStore {
  private readonly internal: Endpoint;
  private readonly public: Endpoint;
  private readonly initialized = new Set<BucketName>();

  constructor(config: ObjectStoreConfiguration) {
    this.internal = endpoint(config.endpoint, config);
    this.public = endpoint(config.publicEndpoint, config);
  }

  async ensureBuckets(signal: AbortSignal): Promise<void> {
    for (const bucket of BUCKETS) {
      abortIfRequested(signal);
      if (this.initialized.has(bucket)) continue;
      try {
        await this.internal.client.send(new HeadBucketCommand({ Bucket: bucket }), { abortSignal: signal });
      } catch (error) {
        if (!isMissingBucket(error)) throw error;
        await this.internal.client.send(new CreateBucketCommand({ Bucket: bucket }), { abortSignal: signal });
      }
      await this.internal.client.send(new PutBucketVersioningCommand({
        Bucket: bucket,
        VersioningConfiguration: { Status: "Enabled" },
      }), { abortSignal: signal });
      await this.internal.client.send(new PutBucketLifecycleConfigurationCommand({
        Bucket: bucket,
        LifecycleConfiguration: {
          Rules: [
            {
              ID: "mathpilot-quarantine-expiry",
              Status: "Enabled",
              Filter: { Prefix: "quarantine/" },
              Expiration: { Days: 1 },
              NoncurrentVersionExpiration: { NoncurrentDays: 1 },
              AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
            },
            {
              ID: "mathpilot-canonical-noncurrent-expiry",
              Status: "Enabled",
              Filter: { Prefix: "objects/" },
              NoncurrentVersionExpiration: { NoncurrentDays: 1 },
              AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
            },
          ],
        },
      }), { abortSignal: signal });
      this.initialized.add(bucket);
    }
  }

  async createUploadPolicy(input: {
    audience: DataPlaneAudience;
    bucket: BucketName;
    key: string;
    mimeType: string;
    byteSize: number;
    expiresAt: Date;
    objectId: string;
  }, signal: AbortSignal): Promise<UploadPostPolicy> {
    await this.ensureBuckets(signal);
    abortIfRequested(signal);
    const selected = input.audience === "public" ? this.public : this.internal;
    const expires = Math.floor((input.expiresAt.getTime() - Date.now()) / 1_000);
    if (expires < 1) throw new Error("S3 upload policy expiry must be in the future");
    const signed = await createPresignedPost(selected.client, {
      Bucket: input.bucket,
      Key: input.key,
      Expires: expires,
      Fields: {
        "Content-Type": input.mimeType,
        "x-amz-meta-mathpilot-object-id": input.objectId,
      },
      Conditions: [
        ["eq", "$Content-Type", input.mimeType],
        ["eq", "$x-amz-meta-mathpilot-object-id", input.objectId],
        ["content-length-range", input.byteSize, input.byteSize],
      ],
    });
    abortIfRequested(signal);
    return Object.freeze({
      url: signed.url,
      fields: Object.freeze(Object.fromEntries(
        Object.entries(signed.fields).map(([key, value]) => [key, String(value)]),
      )),
    });
  }

  async statSource(
    bucket: BucketName,
    key: string,
    versionId: string | undefined,
    signal: AbortSignal,
  ): Promise<SourceObjectStat> {
    await this.ensureBuckets(signal);
    const value = await this.internal.client.send(new HeadObjectCommand({
      Bucket: bucket,
      Key: key,
      VersionId: versionId,
    }), { abortSignal: signal });
    if (value.ContentLength === undefined || value.ContentLength < 0) {
      throw new Error("S3 did not return the source object size");
    }
    return Object.freeze({
      size: value.ContentLength,
      etag: requiredEtag(value.ETag, "source object"),
      versionId: requiredVersionId(value.VersionId, "source object"),
      ...(value.LastModified ? { lastModified: value.LastModified } : {}),
      metadata: Object.freeze({ ...(value.Metadata ?? {}) }),
    });
  }

  async openSource(bucket: BucketName, key: string, versionId: string, signal: AbortSignal): Promise<Readable> {
    await this.ensureBuckets(signal);
    const value = await this.internal.client.send(new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      VersionId: versionId,
    }), { abortSignal: signal });
    if (value.VersionId && value.VersionId !== versionId) {
      throw new Error("S3 returned a different source object version");
    }
    return nodeReadable(value.Body);
  }

  async putCanonical(input: {
    bucket: BucketName;
    key: string;
    stream: Readable;
    byteSize: number;
    mimeType: string;
    sha256: string;
    objectId: string;
  }, signal: AbortSignal): Promise<StoredVersion> {
    await this.ensureBuckets(signal);
    const value = await this.internal.client.send(new PutObjectCommand({
      Bucket: input.bucket,
      Key: input.key,
      Body: input.stream,
      ContentLength: input.byteSize,
      ContentType: input.mimeType,
      Metadata: {
        "mathpilot-object-id": input.objectId,
        "mathpilot-sha256": input.sha256,
      },
    }), { abortSignal: signal });
    return Object.freeze({
      etag: requiredEtag(value.ETag, "canonical object"),
      versionId: requiredVersionId(value.VersionId, "canonical object"),
    });
  }

  async removeVersion(bucket: BucketName, key: string, versionId: string, signal: AbortSignal): Promise<void> {
    await this.ensureBuckets(signal);
    await this.internal.client.send(new DeleteObjectCommand({
      Bucket: bucket,
      Key: key,
      VersionId: versionId,
    }), { abortSignal: signal });
  }

  async presignedDownload(input: {
    audience: DataPlaneAudience;
    bucket: BucketName;
    key: string;
    versionId: string;
    expiresSeconds: number;
    mimeType: string;
    originalName: string;
    intent: StorageObjectDownloadIntent;
  }, signal: AbortSignal): Promise<string> {
    await this.ensureBuckets(signal);
    abortIfRequested(signal);
    const selected = input.audience === "public" ? this.public : this.internal;
    const value = await getSignedUrl(selected.client, new GetObjectCommand({
      Bucket: input.bucket,
      Key: input.key,
      VersionId: input.versionId,
      ResponseContentType: input.mimeType,
      ResponseContentDisposition: objectContentDisposition(input.intent, input.originalName, input.mimeType),
    }), { expiresIn: input.expiresSeconds });
    abortIfRequested(signal);
    return value;
  }

  close(): void {
    this.internal.client.destroy();
    this.public.client.destroy();
  }
}
