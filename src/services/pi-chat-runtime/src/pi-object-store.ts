import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { Client as MinioClient } from "minio";

const DEFAULT_MAX_ARCHIVE_FILES = 10_000;
const DEFAULT_MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024;

export interface PiObjectStoreConfig {
  endpoint: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
  useSSL?: boolean;
  maxArchiveFiles?: number;
  maxArchiveBytes?: number;
}

interface ListedObject {
  name?: string;
  size?: number;
}

interface ObjectStat {
  size?: number;
}

export interface PiObjectClient {
  bucketExists(bucket: string): Promise<boolean>;
  makeBucket(bucket: string): Promise<unknown>;
  putObject(bucket: string, objectName: string, stream: Readable, size: number): Promise<unknown>;
  listObjectsV2(bucket: string, prefix: string, recursive: boolean): AsyncIterable<ListedObject>;
  statObject(bucket: string, objectName: string): Promise<ObjectStat>;
  fGetObject(bucket: string, objectName: string, filePath: string): Promise<unknown>;
}

export interface ParsedMinioEndpoint {
  host: string;
  port: number;
  useSSL: boolean;
}

export const parseMinioEndpoint = (value: string, configuredUseSSL?: boolean): ParsedMinioEndpoint => {
  const endpoint = value.trim();
  if (!endpoint) throw new Error("MinIO endpoint is required");
  const hasScheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(endpoint);
  const fallbackProtocol = configuredUseSSL ? "https" : "http";
  let parsed: URL;
  try {
    parsed = new URL(hasScheme ? endpoint : `${fallbackProtocol}://${endpoint}`);
  } catch {
    throw new Error("MinIO endpoint is invalid");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("MinIO endpoint must use http or https");
  }
  if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("MinIO endpoint must contain only a host and optional port");
  }
  const endpointUseSSL = parsed.protocol === "https:";
  if (hasScheme && configuredUseSSL !== undefined && configuredUseSSL !== endpointUseSSL) {
    throw new Error("MinIO endpoint scheme conflicts with useSSL");
  }
  const useSSL = configuredUseSSL ?? endpointUseSSL;
  const port = parsed.port ? Number(parsed.port) : hasScheme ? (useSSL ? 443 : 80) : 9000;
  if (!parsed.hostname || !Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("MinIO endpoint host or port is invalid");
  }
  return { host: parsed.hostname, port, useSSL };
};

const positiveLimit = (value: number | undefined, fallback: number, label: string): number => {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) throw new Error(`${label} must be a positive integer`);
  return resolved;
};

const isWithin = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};

const objectSegments = (value: string, label: string): string[] => {
  if (!value || value.includes("\0") || value.includes("\\") || value.startsWith("/")) {
    throw new Error(`${label} is invalid`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`${label} is invalid`);
  }
  return segments;
};

const normalizeObjectKey = (value: string): string => objectSegments(value, "object key").join("/");

const normalizeObjectPrefix = (value: string): string => {
  const withoutSlash = value.endsWith("/") ? value.slice(0, -1) : value;
  return `${objectSegments(withoutSlash, "object prefix").join("/")}/`;
};

const relativeObjectName = (relative: string): string => {
  const segments = relative.split(path.sep);
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment.includes("\\"))) {
    throw new Error("archive path is invalid");
  }
  return segments.join("/");
};

const existingStat = async (file: string) => {
  try {
    return await lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
};

const canonicalDirectory = async (directory: string, label: string): Promise<string> => {
  const info = await lstat(directory);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${label} must be a real directory`);
  return realpath(directory);
};

const containedRealPath = async (allowedRoot: string, candidate: string, label: string): Promise<string> => {
  const resolved = await realpath(candidate);
  if (!isWithin(allowedRoot, resolved)) throw new Error(`${label} escapes its allowed root`);
  return resolved;
};

export class PiObjectStore {
  private readonly client: PiObjectClient;
  private readonly bucket: string;
  private readonly maxArchiveFiles: number;
  private readonly maxArchiveBytes: number;

  constructor(config: PiObjectStoreConfig, client?: PiObjectClient) {
    const endpoint = parseMinioEndpoint(config.endpoint, config.useSSL);
    this.client = client ?? new MinioClient({
      endPoint: endpoint.host,
      port: endpoint.port,
      useSSL: endpoint.useSSL,
      accessKey: config.accessKey,
      secretKey: config.secretKey,
    }) as unknown as PiObjectClient;
    this.bucket = config.bucket;
    this.maxArchiveFiles = positiveLimit(config.maxArchiveFiles, DEFAULT_MAX_ARCHIVE_FILES, "maxArchiveFiles");
    this.maxArchiveBytes = positiveLimit(config.maxArchiveBytes, DEFAULT_MAX_ARCHIVE_BYTES, "maxArchiveBytes");
  }

  private async ensureBucket(): Promise<void> {
    if (!(await this.client.bucketExists(this.bucket))) await this.client.makeBucket(this.bucket);
  }

  private async putRegularFile(objectName: string, file: string, allowedRoot: string, expectedSize?: number): Promise<number> {
    const before = await lstat(file);
    if (before.isSymbolicLink() || !before.isFile()) throw new Error("archive entries must be regular files");
    const resolvedBefore = await realpath(file);
    if (!isWithin(allowedRoot, resolvedBefore)) throw new Error("archive file escapes its root");

    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat();
      const after = await lstat(file);
      const resolvedAfter = await realpath(file);
      if (!opened.isFile() || after.isSymbolicLink() || !after.isFile()
        || opened.dev !== after.dev || opened.ino !== after.ino
        || !isWithin(allowedRoot, resolvedAfter)) {
        throw new Error("archive file changed during validation");
      }
      if (expectedSize !== undefined && opened.size !== expectedSize) {
        throw new Error("archive file changed during snapshot");
      }
      if (opened.size > this.maxArchiveBytes) throw new Error("archive file exceeds byte limit");
      const stream = handle.createReadStream({ autoClose: false });
      try {
        await this.client.putObject(this.bucket, normalizeObjectKey(objectName), stream, opened.size);
      } finally {
        stream.destroy();
      }
      return opened.size;
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  async uploadDirectory(prefixValue: string, directory: string, allowedRootValue = directory): Promise<string> {
    const prefix = normalizeObjectPrefix(prefixValue);
    const allowedRoot = await canonicalDirectory(allowedRootValue, "archive allowed root");
    const root = await canonicalDirectory(directory, "archive root");
    if (!isWithin(allowedRoot, root)) throw new Error("archive root escapes its allowed root");
    const files: Array<{ absolute: string; relative: string; size: number }> = [];
    let totalBytes = 0;

    const walk = async (relative: string): Promise<void> => {
      const absolute = relative ? path.resolve(root, relative) : root;
      if (!isWithin(root, absolute)) throw new Error("archive directory escapes its root");
      const info = await lstat(absolute);
      const resolved = await realpath(absolute);
      if (info.isSymbolicLink() || !info.isDirectory() || !isWithin(root, resolved)) {
        throw new Error("archive directories must remain inside the root");
      }
      const entries = await readdir(absolute, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        if (entry.name.includes("\\")) throw new Error("archive path is invalid");
        const next = relative ? path.join(relative, entry.name) : entry.name;
        const candidate = path.resolve(root, next);
        if (!isWithin(root, candidate)) throw new Error("archive path escapes its root");
        const candidateInfo = await lstat(candidate);
        if (candidateInfo.isSymbolicLink()) throw new Error("archive symlinks are forbidden");
        if (candidateInfo.isDirectory()) {
          await walk(next);
          continue;
        }
        if (!candidateInfo.isFile()) throw new Error("archive entries must be regular files");
        files.push({ absolute: candidate, relative: next, size: candidateInfo.size });
        totalBytes += candidateInfo.size;
        if (files.length > this.maxArchiveFiles) throw new Error("archive exceeds file count limit");
        if (!Number.isSafeInteger(totalBytes) || totalBytes > this.maxArchiveBytes) {
          throw new Error("archive exceeds byte limit");
        }
      }
    };

    await walk("");
    await this.ensureBucket();
    for (const file of files) {
      await this.putRegularFile(`${prefix}${relativeObjectName(file.relative)}`, file.absolute, root, file.size);
    }
    return prefix.slice(0, -1);
  }

  private async safeDownloadTarget(root: string, relativeName: string): Promise<string> {
    const segments = objectSegments(relativeName, "object relative path");
    const target = path.resolve(root, ...segments);
    if (!isWithin(root, target) || target === root) throw new Error("object path escapes download root");

    let parent = root;
    for (const segment of segments.slice(0, -1)) {
      parent = path.join(parent, segment);
      await mkdir(parent).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      });
      const info = await lstat(parent);
      const resolved = await realpath(parent);
      if (info.isSymbolicLink() || !info.isDirectory() || !isWithin(root, resolved)) {
        throw new Error("download directory is unsafe");
      }
    }
    if (await existingStat(target)) throw new Error("download target already exists");
    return target;
  }

  async downloadDirectory(prefixValue: string, directory: string, allowedRootValue = path.dirname(directory)): Promise<void> {
    const prefix = normalizeObjectPrefix(prefixValue);
    const listed: Array<{ name: string; relativeName: string; size: number }> = [];
    let totalBytes = 0;
    for await (const object of this.client.listObjectsV2(this.bucket, prefix, true)) {
      if (typeof object.name !== "string" || !object.name.startsWith(prefix)) {
        throw new Error("object listing escaped its prefix");
      }
      const relativeName = object.name.slice(prefix.length);
      objectSegments(relativeName, "object relative path");
      if (typeof object.size !== "number" || !Number.isSafeInteger(object.size) || object.size < 0) {
        throw new Error("object listing omitted a valid byte size");
      }
      listed.push({ name: object.name, relativeName, size: object.size });
      totalBytes += object.size;
      if (listed.length > this.maxArchiveFiles) throw new Error("archive exceeds file count limit");
      if (!Number.isSafeInteger(totalBytes) || totalBytes > this.maxArchiveBytes) {
        throw new Error("archive exceeds byte limit");
      }
    }

    const allowedRoot = await canonicalDirectory(allowedRootValue, "download allowed root");
    const destination = path.resolve(directory);
    if (!isWithin(allowedRoot, destination) || destination === allowedRoot || await existingStat(destination)) {
      throw new Error("download destination is unsafe or already exists");
    }
    const destinationParent = path.dirname(destination);
    const parentReal = await containedRealPath(allowedRoot, destinationParent, "download parent");
    const staging = await mkdtemp(path.join(parentReal, `.${path.basename(destination)}.restore-`));
    try {
      const root = await canonicalDirectory(staging, "download staging root");
      for (const object of listed) {
        const target = await this.safeDownloadTarget(root, object.relativeName);
        try {
          await this.client.fGetObject(this.bucket, object.name, target);
          const info = await lstat(target);
          const resolved = await realpath(target);
          if (info.isSymbolicLink() || !info.isFile() || info.size !== object.size || !isWithin(root, resolved)) {
            throw new Error("downloaded object is not a contained regular file");
          }
        } catch (error) {
          await rm(target, { force: true }).catch(() => undefined);
          throw error;
        }
      }
      await rename(staging, destination);
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  async uploadFile(keyValue: string, file: string, allowedRootValue = path.dirname(file)): Promise<void> {
    const key = normalizeObjectKey(keyValue);
    const allowedRoot = await canonicalDirectory(allowedRootValue, "file upload allowed root");
    const info = await lstat(file);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error("archive entries must be regular files");
    if (info.size > this.maxArchiveBytes) throw new Error("archive file exceeds byte limit");
    await containedRealPath(allowedRoot, file, "archive file");
    await this.ensureBucket();
    await this.putRegularFile(key, file, allowedRoot, info.size);
  }

  async downloadFile(keyValue: string, file: string, allowedRootValue = path.dirname(file)): Promise<void> {
    const key = normalizeObjectKey(keyValue);
    const allowedRoot = await canonicalDirectory(allowedRootValue, "file download allowed root");
    const destination = path.resolve(file);
    if (!isWithin(allowedRoot, destination) || destination === allowedRoot || await existingStat(destination)) {
      throw new Error("download target is unsafe or already exists");
    }
    const parent = await containedRealPath(allowedRoot, path.dirname(destination), "download parent");
    const remote = await this.client.statObject(this.bucket, key);
    if (typeof remote.size !== "number" || !Number.isSafeInteger(remote.size)
      || remote.size < 0 || remote.size > this.maxArchiveBytes) {
      throw new Error("object size is invalid or exceeds the byte limit");
    }
    const stagingDirectory = await mkdtemp(path.join(parent, `.${path.basename(destination)}.restore-`));
    const stagingFile = path.join(stagingDirectory, "object");
    try {
      await this.client.fGetObject(this.bucket, key, stagingFile);
      const info = await lstat(stagingFile);
      if (info.isSymbolicLink() || !info.isFile() || info.size !== remote.size) {
        throw new Error("downloaded object is not a valid regular file");
      }
      await rename(stagingFile, destination);
    } catch (error) {
      throw error;
    } finally {
      await rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
