import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import { Client as MinioClient, type BucketItemStat } from "minio";

export const BUCKETS = ["mathpilot-content", "mathpilot-working", "mathpilot-session"] as const;
export type BucketName = (typeof BUCKETS)[number];

type Endpoint = { client: MinioClient; origin: string };
export type PresignAudience = "public" | "internal";

function endpoint(value: string, accessKey: string, secretKey: string, region: string): Endpoint {
  const parsed = new URL(value.includes("://") ? value : `http://${value}`);
  if (!parsed.hostname) throw new Error("MinIO endpoint host is required");
  return {
    client: new MinioClient({
      endPoint: parsed.hostname,
      port: parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80,
      useSSL: parsed.protocol === "https:",
      accessKey,
      secretKey,
      region,
      pathStyle: true,
    }),
    origin: `${parsed.protocol}//${parsed.host}`,
  };
}

export interface VerifiedObject {
  stat: BucketItemStat;
  sha256: string;
}

export class ObjectStore {
  private readonly internal: Endpoint;
  private readonly public: Endpoint;
  private readonly buckets = new Set<BucketName>();

  constructor(config: { endpoint: string; publicEndpoint: string; accessKey: string; secretKey: string; region: string }) {
    this.internal = endpoint(config.endpoint, config.accessKey, config.secretKey, config.region);
    this.public = endpoint(config.publicEndpoint, config.accessKey, config.secretKey, config.region);
  }

  get publicOrigin(): string {
    return this.public.origin;
  }

  async ensureBuckets(): Promise<void> {
    for (const bucket of BUCKETS) {
      if (this.buckets.has(bucket)) continue;
      if (!(await this.internal.client.bucketExists(bucket))) await this.internal.client.makeBucket(bucket);
      // MinIO accepts the S3 versioning configuration used here.  Repeating
      // this call is harmless and repairs a bucket created by an older local
      // compose volume.
      await this.internal.client.setBucketVersioning(bucket, { Status: "Enabled" });
      this.buckets.add(bucket);
    }
  }

  async presignedPut(bucket: BucketName, key: string, expiresSeconds: number): Promise<string> {
    await this.ensureBuckets();
    return this.public.client.presignedPutObject(bucket, key, expiresSeconds);
  }

  async presignedInternalPut(bucket: BucketName, key: string, expiresSeconds: number): Promise<string> {
    await this.ensureBuckets();
    return this.internal.client.presignedPutObject(bucket, key, expiresSeconds);
  }

  async presignedGet(bucket: BucketName, key: string, expiresSeconds: number, versionId?: string | null): Promise<string> {
    await this.ensureBuckets();
    return this.public.client.presignedGetObject(bucket, key, expiresSeconds, versionId ? { versionId } : undefined);
  }

  async presignedInternalGet(bucket: BucketName, key: string, expiresSeconds: number, versionId?: string | null): Promise<string> {
    await this.ensureBuckets();
    return this.internal.client.presignedGetObject(bucket, key, expiresSeconds, versionId ? { versionId } : undefined);
  }

  async verify(bucket: BucketName, key: string, expectedSize: number, expectedMime: string): Promise<VerifiedObject> {
    await this.ensureBuckets();
    const stat = await this.internal.client.statObject(bucket, key);
    if (stat.size !== expectedSize) throw new Error(`object size mismatch: expected ${expectedSize}, got ${stat.size}`);
    const metadata = stat.metaData ?? {};
    const contentType = Object.entries(metadata).find(([name]) => name.toLowerCase() === "content-type")?.[1];
    if (typeof contentType === "string" && contentType && contentType.split(";", 1)[0]!.toLowerCase() !== expectedMime.toLowerCase()) {
      throw new Error("object MIME type mismatch");
    }
    const stream = await this.internal.client.getObject(bucket, key);
    const hash = createHash("sha256");
    for await (const chunk of stream as Readable) hash.update(chunk as Uint8Array);
    return { stat, sha256: hash.digest("hex") };
  }

  async removeVersion(bucket: BucketName, key: string, versionId: string, signal: AbortSignal): Promise<void> {
    await this.ensureBuckets();
    if (signal.aborted) throw new Error("storage deletion was aborted");
    await this.internal.client.removeObject(bucket, key, { versionId });
  }
}
