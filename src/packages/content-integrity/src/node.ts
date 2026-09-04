import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { chmod, link, mkdir, mkdtemp, open, readFile, realpath, rename, rm, stat, unlink } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import os from "node:os";
import path from "node:path";
import canonicalize from "canonicalize";
import { fileTypeFromBuffer, fileTypeFromFile } from "file-type";
import sharp from "sharp";
import {
  immutableObjectDescriptorSchema,
  storageObjectResolveResponseSchema,
  type ContentPolicy,
  type ImmutableObjectDescriptor,
  type ImageNormalizationPolicy,
} from "./policy.ts";

export interface ContentMetadata {
  readonly byteSize: number;
  readonly mimeType: string;
  readonly sha256: string;
}

export interface SealedContent {
  readonly source: ContentMetadata;
  readonly stored: ContentMetadata;
  readonly storedPath: string;
  openStored(): NodeJS.ReadableStream;
  cleanup(): Promise<void>;
}

export class ContentIntegrityError extends Error {
  override readonly name = "ContentIntegrityError";
  constructor(
    readonly code: string,
    message: string,
    readonly disposition: "terminal" | "retryable" = "terminal",
  ) { super(message); }
}

const abortError = (): Error => Object.assign(new Error("content operation aborted"), { name: "AbortError" });

const normalizedMime = (value: string): string => value.split(";", 1)[0]!.trim().toLowerCase();

const writeBounded = async (
  source: AsyncIterable<Uint8Array>,
  target: string,
  maximumBytes: number,
  signal?: AbortSignal,
): Promise<{ byteSize: number; sha256: string }> => {
  const handle = await open(target, "wx", 0o600);
  const hash = createHash("sha256");
  let byteSize = 0;
  const iterator = source[Symbol.asyncIterator]();
  let completed = false;
  let rejectAbort: ((error: Error) => void) | undefined;
  const aborted = signal
    ? new Promise<never>((_resolve, reject) => { rejectAbort = reject; })
    : undefined;
  const onAbort = () => rejectAbort?.(abortError());
  if (signal?.aborted) onAbort(); else signal?.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      const next = await (aborted ? Promise.race([iterator.next(), aborted]) : iterator.next());
      if (next.done) {
        completed = true;
        break;
      }
      const value = next.value;
      const chunk = Buffer.from(value);
      byteSize += chunk.byteLength;
      if (byteSize > maximumBytes) {
        throw new ContentIntegrityError("content_too_large", `content exceeds ${maximumBytes} bytes`);
      }
      hash.update(chunk);
      let offset = 0;
      while (offset < chunk.byteLength) {
        const written = await handle.write(chunk, offset, chunk.byteLength - offset, null);
        if (written.bytesWritten < 1) {
          throw new ContentIntegrityError(
            "content_write_failed",
            "temporary content write made no progress",
            "retryable",
          );
        }
        offset += written.bytesWritten;
      }
    }
    if (signal?.aborted) throw abortError();
    await handle.sync();
    return { byteSize, sha256: hash.digest("hex") };
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (!completed) await iterator.return?.().catch(() => undefined);
    await handle.close().catch(() => undefined);
  }
};

const strictText = async (file: string, maximumBytes: number): Promise<string> => {
  const bytes = await readFile(file);
  if (bytes.byteLength > maximumBytes) throw new ContentIntegrityError("content_too_large", "text content exceeds policy");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ContentIntegrityError("invalid_text_encoding", "text content is not canonical UTF-8");
  }
  if (text.includes("\u0000")) throw new ContentIntegrityError("invalid_text_content", "text content contains NUL bytes");
  return text;
};

const identify = async (file: string, declaredMime: string, policy: ContentPolicy): Promise<string> => {
  const detected = await fileTypeFromFile(file);
  let actual = detected?.mime;
  if (!actual && declaredMime === "application/json") {
    const text = await strictText(file, policy.maximumSourceBytes);
    try { JSON.parse(text); } catch { throw new ContentIntegrityError("invalid_json", "content is not valid JSON"); }
    actual = "application/json";
  } else if (!actual && declaredMime.startsWith("text/")) {
    await strictText(file, policy.maximumSourceBytes);
    actual = declaredMime;
  }
  if (!actual || !policy.allowedMimeTypes.includes(actual)) {
    throw new ContentIntegrityError("unsupported_content_type", `detected content type ${actual ?? "unknown"} is not allowed for ${policy.purpose}`);
  }
  if (actual !== declaredMime) {
    throw new ContentIntegrityError("content_type_mismatch", `declared content type ${declaredMime} does not match ${actual}`);
  }
  return actual;
};

const assertImageMetadata = (
  metadata: Awaited<ReturnType<ReturnType<typeof sharp>["metadata"]>>,
  policy: ImageNormalizationPolicy,
): void => {
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  const channels = metadata.channels ?? 0;
  const pages = metadata.pages ?? 1;
  if (width < 1 || height < 1 || width > policy.maximumDimension || height > policy.maximumDimension
    || width * height > policy.maximumPixels || channels < 1 || channels > policy.maximumChannels || pages !== 1) {
    throw new ContentIntegrityError("unsafe_image_dimensions", "image dimensions, channels, or page count exceed policy");
  }
};

const normalizeImage = async (
  sourcePath: string,
  storedPath: string,
  policy: ImageNormalizationPolicy,
  maximumStoredBytes: number,
): Promise<ContentMetadata> => {
  try {
    const decoder = sharp(sourcePath, {
      failOn: "warning",
      limitInputPixels: policy.maximumPixels,
      limitInputChannels: policy.maximumChannels,
      unlimited: false,
      sequentialRead: true,
      pages: 1,
      animated: false,
    });
    assertImageMetadata(await decoder.metadata(), policy);
    let output = decoder.autoOrient();
    if (policy.resizeWithin !== undefined) {
      output = output.resize(policy.resizeWithin, policy.resizeWithin, { fit: "inside", withoutEnlargement: true });
    }
    await output.webp({ quality: policy.webpQuality, effort: 4 }).timeout({ seconds: 15 }).toFile(storedPath);
  } catch (error) {
    if (error instanceof ContentIntegrityError || (error as Error).name === "AbortError") throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code && ["EACCES","EDQUOT","EMFILE","ENFILE","ENOSPC","EROFS"].includes(code)) {
      throw new ContentIntegrityError("image_transform_unavailable", "image normalization is temporarily unavailable", "retryable");
    }
    throw new ContentIntegrityError("invalid_image_content", "image cannot be safely decoded and normalized");
  }
  const info = await stat(storedPath);
  if (info.size < 1 || info.size > maximumStoredBytes) {
    throw new ContentIntegrityError("normalized_content_too_large", "normalized image exceeds stored-byte policy");
  }
  const sha256 = createHash("sha256").update(await readFile(storedPath)).digest("hex");
  return { byteSize: info.size, mimeType: "image/webp", sha256 };
};

const normalizeJson = async (
  sourcePath: string,
  storedPath: string,
  maximumSourceBytes: number,
  maximumStoredBytes: number,
): Promise<ContentMetadata> => {
  const text = await strictText(sourcePath,maximumSourceBytes);
  let value: unknown;
  try { value=JSON.parse(text); } catch { throw new ContentIntegrityError("invalid_json","content is not valid JSON"); }
  const canonical=canonicalJson(value,maximumStoredBytes);
  const handle=await open(storedPath,"wx",0o600);
  try {
    await handle.writeFile(canonical.json,"utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  return { byteSize:canonical.byteSize,mimeType:"application/json",sha256:canonical.sha256 };
};

export async function sealContent(
  source: AsyncIterable<Uint8Array>,
  policy: ContentPolicy,
  options: { declaredMimeType: string; expectedBytes?: number; signal?: AbortSignal } ,
): Promise<SealedContent> {
  const declaredMime = normalizedMime(options.declaredMimeType);
  if (!policy.allowedMimeTypes.includes(declaredMime)) {
    throw new ContentIntegrityError("unsupported_declared_type", `declared content type ${declaredMime || "empty"} is not allowed for ${policy.purpose}`);
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), "mathpilot-content-"));
  const sourcePath = path.join(directory, "source");
  const storedPath = path.join(directory, "stored");
  try {
    const captured = await writeBounded(source, sourcePath, policy.maximumSourceBytes, options.signal);
    if (captured.byteSize < 1) throw new ContentIntegrityError("empty_content", "content is empty");
    if (options.expectedBytes !== undefined && captured.byteSize !== options.expectedBytes) {
      throw new ContentIntegrityError("content_size_mismatch", `expected ${options.expectedBytes} bytes, received ${captured.byteSize}`);
    }
    const actualMime = await identify(sourcePath, declaredMime, policy);
    const sourceMetadata = { ...captured, mimeType: actualMime };
    if (options.signal?.aborted) throw abortError();
    const storedMetadata = policy.image && actualMime.startsWith("image/")
      ? await normalizeImage(sourcePath, storedPath, policy.image, policy.maximumStoredBytes)
      : policy.canonicalJson && actualMime==="application/json"
        ? await normalizeJson(sourcePath,storedPath,policy.maximumSourceBytes,policy.maximumStoredBytes)
        : sourceMetadata;
    if (options.signal?.aborted) throw abortError();
    const finalPath = storedMetadata === sourceMetadata ? sourcePath : storedPath;
    return Object.freeze({
      source: Object.freeze(sourceMetadata),
      stored: Object.freeze(storedMetadata),
      storedPath: finalPath,
      openStored: () => createReadStream(finalPath),
      cleanup: () => rm(directory, { recursive: true, force: true }),
    });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

const pathIsWithin = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
};

/**
 * Freeze one host-authorized regular file without reopening its pathname.
 * Model-writable directories can change between validation and reading, so
 * the exact opened descriptor is both authorized and sealed.
 */
export async function sealBoundedHostFile(input: {
  readonly root: string;
  readonly file: string;
  readonly policy: ContentPolicy;
  readonly declaredMimeType: string;
  readonly signal?: AbortSignal;
}): Promise<SealedContent> {
  const lexicalRoot = path.resolve(input.root);
  const target = path.resolve(input.file);
  if (target === lexicalRoot || !pathIsWithin(lexicalRoot, target)) {
    throw new ContentIntegrityError("host_file_outside_root", "host file is outside its authorized root");
  }
  const authorizedRoot = await realpath(lexicalRoot);
  if (!(await stat(authorizedRoot)).isDirectory()) {
    throw new ContentIntegrityError("invalid_host_root", "host file root is not a directory");
  }

  let handle;
  try {
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new ContentIntegrityError("unsafe_host_file", "host file must not be a symbolic link");
    }
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size < 1 || info.size > input.policy.maximumSourceBytes) {
      throw new ContentIntegrityError("invalid_host_file", "host file is not a bounded regular file");
    }
    const openedPath = await realpath(`/proc/self/fd/${handle.fd}`);
    if (openedPath === authorizedRoot || !pathIsWithin(authorizedRoot, openedPath)) {
      throw new ContentIntegrityError("host_file_outside_root", "opened host file is outside its authorized root");
    }
    return await sealContent(
      handle.createReadStream({ autoClose: false, start: 0 }),
      input.policy,
      {
        declaredMimeType: input.declaredMimeType,
        expectedBytes: info.size,
        ...(input.signal ? { signal: input.signal } : {}),
      },
    );
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export async function materializeVerified(
  source: AsyncIterable<Uint8Array>,
  descriptor: Pick<ImmutableObjectDescriptor, "byte_size" | "sha256" | "mime_type">,
  destination: string,
  options: { signal?: AbortSignal; maximumBytes?: number } = {},
): Promise<void> {
  const parent = path.dirname(destination);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const temporary = path.join(parent, `.${path.basename(destination)}.${randomUUID()}.partial`);
  try {
    const captured = await writeBounded(
      source,
      temporary,
      Math.min(options.maximumBytes ?? descriptor.byte_size, descriptor.byte_size),
      options.signal,
    );
    if (captured.byteSize !== descriptor.byte_size || captured.sha256 !== descriptor.sha256) {
      throw new ContentIntegrityError("immutable_object_mismatch", "materialized object does not match its immutable descriptor");
    }
    const detected = await fileTypeFromFile(temporary);
    if (detected && detected.mime !== descriptor.mime_type) {
      throw new ContentIntegrityError("immutable_object_type_mismatch", "materialized object type does not match its immutable descriptor");
    }
    if (!detected && (descriptor.mime_type === "application/json" || descriptor.mime_type.startsWith("text/"))) {
      await strictText(temporary, descriptor.byte_size);
    }
    await chmod(temporary, 0o400);
    try {
      await link(temporary, destination);
      await unlink(temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
      await rename(temporary, destination);
    }
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export interface ImmutableObjectMaterialization {
  readonly descriptor: ImmutableObjectDescriptor;
  readonly destination: string;
}

/**
 * Shared Storage data-plane consumer. Domain adapters only authorize an edge
 * and choose destinations; descriptor equality, response cancellation,
 * bounded download, MIME/hash/size verification, and atomic publication live
 * here for every host-side object projection.
 */
export async function resolveAndMaterializeObjects(input: {
  readonly objects: readonly ImmutableObjectMaterialization[];
  readonly maximumAggregateBytes: number;
  readonly signal: AbortSignal;
  readonly resolve: (objectRefs: readonly string[], signal: AbortSignal) => Promise<Response>;
}): Promise<void> {
  const requested = input.objects.map(({ descriptor }) => immutableObjectDescriptorSchema.parse(descriptor));
  if (requested.length < 1 || requested.length > 64) throw new Error("immutable object projection must contain 1 to 64 objects");
  if (!Number.isSafeInteger(input.maximumAggregateBytes) || input.maximumAggregateBytes < 1) {
    throw new Error("immutable object projection requires a positive aggregate byte budget");
  }
  if (new Set(requested.map((value) => value.object_ref)).size !== requested.length) {
    throw new Error("immutable object projection repeats an object");
  }
  let aggregateBytes = 0;
  for (const descriptor of requested) {
    if (descriptor.byte_size > input.maximumAggregateBytes - aggregateBytes) {
      throw new Error(`immutable object projection exceeds ${input.maximumAggregateBytes} bytes`);
    }
    aggregateBytes += descriptor.byte_size;
    if (descriptor.expires_at !== null && Date.parse(descriptor.expires_at) <= Date.now()) {
      throw new Error("immutable object descriptor has expired");
    }
  }

  const response = await input.resolve(requested.map((value) => value.object_ref), input.signal);
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`storage-next rejected an authorized object resolve (${response.status})`);
  }
  const resolved = storageObjectResolveResponseSchema.parse(await response.json());
  if (resolved.objects.length !== requested.length) throw new Error("storage-next returned an incomplete object resolution");
  const byRef = new Map(resolved.objects.map((value) => [value.object_ref, value]));

  for (let index = 0; index < input.objects.length; index += 1) {
    const target = input.objects[index]!;
    const frozen = requested[index]!;
    const object = byRef.get(frozen.object_ref);
    if (!object) throw new Error("storage-next object metadata does not match the frozen projection");
    const { download: _download, ...descriptorValue } = object;
    const resolvedDescriptor = immutableObjectDescriptorSchema.parse(descriptorValue);
    if (!isDeepStrictEqual(frozen, resolvedDescriptor)) {
      throw new Error("storage-next object metadata does not match the frozen projection");
    }

    const signal = AbortSignal.any([input.signal, AbortSignal.timeout(30_000)]);
    const download = await fetch(object.download.url, { signal, redirect: "error" });
    if (!download.ok || !download.body) {
      await download.body?.cancel().catch(() => undefined);
      throw new Error(`immutable object download failed (${download.status})`);
    }
    const contentLength = download.headers.get("content-length");
    if (contentLength !== null && Number(contentLength) !== frozen.byte_size) {
      await download.body.cancel().catch(() => undefined);
      throw new Error("immutable object Content-Length does not match its descriptor");
    }
    try {
      await materializeVerified(
        download.body as unknown as AsyncIterable<Uint8Array>,
        frozen,
        target.destination,
        { signal, maximumBytes: frozen.byte_size },
      );
    } catch (error) {
      await download.body.cancel().catch(() => undefined);
      throw error;
    }
  }
}

export async function identifyImageBytes(bytes: Uint8Array, maximumBytes = 48 * 1024 * 1024): Promise<string | undefined> {
  if (bytes.byteLength < 1 || bytes.byteLength > maximumBytes) return undefined;
  const detected = await fileTypeFromBuffer(bytes);
  if (!detected?.mime.startsWith("image/")) return undefined;
  try {
    const decoder = sharp(bytes, {
      failOn: "warning",
      limitInputPixels: 40_000_000,
      limitInputChannels: 4,
      unlimited: false,
      pages: 1,
      animated: false,
    });
    const metadata = await decoder.metadata();
    assertImageMetadata(metadata, { maximumPixels: 40_000_000, maximumChannels: 4, maximumDimension: 12_000, webpQuality: 90 });
    // metadata() intentionally reads headers only. A bounded re-encode forces
    // the complete image through libvips before the tool reports a MIME type.
    await decoder.webp({ quality: 80, effort: 1 }).timeout({ seconds: 10 }).toBuffer();
    return detected.mime;
  } catch {
    return undefined;
  }
}

export function canonicalJson(value: unknown, maximumBytes = 1024 * 1024): { json: string; sha256: string; byteSize: number } {
  const json = canonicalize(value);
  if (json === undefined) throw new ContentIntegrityError("non_canonical_json", "value cannot be represented as canonical JSON");
  const byteSize = Buffer.byteLength(json, "utf8");
  if (byteSize > maximumBytes) throw new ContentIntegrityError("json_too_large", `canonical JSON exceeds ${maximumBytes} bytes`);
  return { json, byteSize, sha256: createHash("sha256").update(json, "utf8").digest("hex") };
}

export function verifyCanonicalJson(value: unknown, expectedSha256: string, maximumBytes = 1024 * 1024): void {
  if (canonicalJson(value, maximumBytes).sha256 !== expectedSha256) {
    throw new ContentIntegrityError("json_digest_mismatch", "stored JSON does not match its canonical digest");
  }
}
