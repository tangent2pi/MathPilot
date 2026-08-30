import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { Client as MinioClient } from "minio";

export interface PiObjectStoreConfig {
  endpoint: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
  useSSL?: boolean;
}

export class PiObjectStore {
  private readonly client: MinioClient;
  private readonly bucket: string;

  constructor(config: PiObjectStoreConfig) {
    const [host, port] = config.endpoint.split(":");
    if (!host) throw new Error("MinIO endpoint host is required");
    this.client = new MinioClient({
      endPoint: host,
      port: Number(port ?? 9000),
      useSSL: config.useSSL ?? false,
      accessKey: config.accessKey,
      secretKey: config.secretKey,
    });
    this.bucket = config.bucket;
  }

  private async ensureBucket(): Promise<void> {
    if (!(await this.client.bucketExists(this.bucket))) await this.client.makeBucket(this.bucket);
  }

  async uploadDirectory(prefix: string, directory: string): Promise<string> {
    await this.ensureBucket();
    const walk = async (relative: string): Promise<void> => {
      const absolute = path.join(directory, relative);
      for (const entry of await readdir(absolute, { withFileTypes: true })) {
        const next = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await walk(next);
        else await this.client.fPutObject(this.bucket, `${prefix}${next}`, path.join(directory, next));
      }
    };
    await walk("");
    return prefix.replace(/\/$/, "");
  }

  async downloadDirectory(prefix: string, directory: string): Promise<void> {
    await mkdir(directory, { recursive: true });
    const tasks: Promise<void>[] = [];
    const stream = this.client.listObjectsV2(this.bucket, prefix, true);
    await new Promise<void>((resolve, reject) => {
      stream.on("error", reject);
      stream.on("data", (object) => {
        if (!object.name) return;
        const target = path.join(directory, object.name.slice(prefix.length));
        tasks.push(mkdir(path.dirname(target), { recursive: true }).then(() => this.client.fGetObject(this.bucket, object.name!, target)));
      });
      stream.on("end", resolve);
    });
    await Promise.all(tasks);
  }

  async uploadFile(key: string, file: string): Promise<void> {
    await this.ensureBucket();
    await this.client.fPutObject(this.bucket, key, file);
  }

  async downloadFile(key: string, file: string): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true });
    await this.client.fGetObject(this.bucket, key, file);
  }
}
