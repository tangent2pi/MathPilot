import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import {
  CONTENT_POLICIES,
  immutableObjectDescriptorSchema,
  type ImmutableObjectDescriptor,
} from "@mathpilot/content-integrity";
import {
  canonicalJson,
  resolveAndMaterializeObjects,
} from "@mathpilot/content-integrity/node";
import type { InternalActor, InternalServiceRuntime } from "@mathpilot/internal-service";
import {
  hostStateDirectory,
  hostStatePath,
  writeHostStateJson,
} from "./host-principal.ts";

export interface HostSourceObject {
  readonly workspace_path: string;
  readonly descriptor: ImmutableObjectDescriptor;
}

export interface HostSourceManifest {
  readonly schema: "mathpilot.pi-source-manifest/v1";
  readonly source_objects: readonly HostSourceObject[];
}

const SOURCE_MANIFEST_FILE = "source-manifest.json";
const SOURCE_PATH = /^input\/original\/([^/\\\u0000-\u001f\u007f]{1,240})$/u;

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};

const parseSourcePath = (value: unknown): string => {
  if (typeof value !== "string") throw new Error("host source workspace_path is invalid");
  const match = SOURCE_PATH.exec(value);
  if (!match || match[1] === "." || match[1] === ".." || path.posix.normalize(value) !== value) {
    throw new Error("host source workspace_path is invalid");
  }
  return value;
};

export const parseHostSourceManifest = (value: unknown): HostSourceManifest => {
  const outer = record(value);
  if (!outer || !hasExactKeys(outer, ["schema", "source_objects"])
    || outer.schema !== "mathpilot.pi-source-manifest/v1"
    || !Array.isArray(outer.source_objects)
    || outer.source_objects.length < 1
    || outer.source_objects.length > 64) {
    throw new Error("host source manifest is invalid or empty");
  }
  const sourceObjects = outer.source_objects.map((candidate) => {
    const item = record(candidate);
    if (!item || !hasExactKeys(item, ["workspace_path", "descriptor"])) {
      throw new Error("host source manifest item is invalid");
    }
    return Object.freeze({
      workspace_path: parseSourcePath(item.workspace_path),
      descriptor: immutableObjectDescriptorSchema.parse(item.descriptor),
    });
  });
  if (new Set(sourceObjects.map((item) => item.workspace_path)).size !== sourceObjects.length) {
    throw new Error("host source manifest repeats a workspace path");
  }
  if (new Set(sourceObjects.map((item) => item.descriptor.object_ref)).size !== sourceObjects.length) {
    throw new Error("host source manifest repeats an immutable object");
  }
  return Object.freeze({
    schema: "mathpilot.pi-source-manifest/v1",
    source_objects: Object.freeze(sourceObjects),
  });
};

export const sourceManifestFromFrozen = (value: unknown): HostSourceManifest => {
  const frozen = record(value);
  if (!frozen || !Object.hasOwn(frozen, "source_objects")) {
    throw new Error("approved candidate has no frozen source objects");
  }
  return parseHostSourceManifest({
    schema: "mathpilot.pi-source-manifest/v1",
    source_objects: frozen.source_objects,
  });
};

export async function readHostSourceManifest(cwd: string): Promise<HostSourceManifest> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(hostStatePath(cwd, SOURCE_MANIFEST_FILE), "utf8")) as unknown;
  } catch {
    throw new Error("Pi host source manifest is missing or unreadable");
  }
  return parseHostSourceManifest(value);
}

export async function writeHostSourceManifest(cwd: string, value: HostSourceManifest): Promise<void> {
  const manifest = parseHostSourceManifest(value);
  await writeHostStateJson(cwd, SOURCE_MANIFEST_FILE, canonicalJson(manifest).json);
}

/**
 * Thin Pi adapter over the shared immutable-object resolver. Downloads remain
 * outside the model workspace until the complete descriptor set verifies.
 */
export async function materializeHostSourceManifest(input: {
  readonly workspace: string;
  readonly manifest: HostSourceManifest;
  readonly actor: InternalActor;
  readonly internalService: InternalServiceRuntime;
  readonly signal: AbortSignal;
}): Promise<void> {
  const manifest = parseHostSourceManifest(input.manifest);
  const state = hostStateDirectory(input.workspace);
  await mkdir(state, { recursive: true, mode: 0o700 });
  let existingInfo;
  try {
    existingInfo = await lstat(hostStatePath(input.workspace, SOURCE_MANIFEST_FILE));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (existingInfo?.isSymbolicLink() || (existingInfo && !existingInfo.isFile())) {
    throw new Error("Pi host source manifest must be a regular file");
  }
  const existingManifest = existingInfo
    ? await readHostSourceManifest(input.workspace)
    : undefined;
  if (existingManifest && !isDeepStrictEqual(existingManifest, manifest)) {
    throw new Error("Pi thread source manifest changed after binding");
  }
  const nonce = randomUUID();
  const staging = path.join(state, `source-staging-${nonce}`);
  const previous = path.join(state, `source-previous-${nonce}`);
  const destination = path.join(input.workspace, "input", "original");
  let previousMoved = false;
  let published = false;
  await mkdir(staging, { mode: 0o700 });
  try {
    await resolveAndMaterializeObjects({
      signal: input.signal,
      maximumAggregateBytes: CONTENT_POLICIES.thread.maximumStoredBytes,
      objects: manifest.source_objects.map((item) => ({
        descriptor: item.descriptor,
        destination: path.join(staging, path.basename(item.workspace_path)),
      })),
      resolve: (objectRefs, signal) => input.internalService.request(
        "pi-to-storage",
        input.actor,
        "/internal/objects/resolve",
        {
          method: "POST",
          json: { object_refs: objectRefs },
          signal,
          timeoutMs: 30_000,
        },
      ),
    });

    try {
      await rename(destination, previous);
      previousMoved = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      await rename(staging, destination);
      published = true;
      await writeHostSourceManifest(input.workspace, manifest);
    } catch (error) {
      if (published) await rm(destination, { recursive: true, force: true });
      if (previousMoved) {
        await rename(previous, destination);
        previousMoved = false;
      }
      published = false;
      throw error;
    }
    if (previousMoved) {
      await rm(previous, { recursive: true, force: true });
      previousMoved = false;
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
    if (!published && previousMoved) {
      await rename(previous, destination).catch(() => undefined);
    }
  }
}

export const candidateSourceObjects = (
  kind: "ktq" | "er",
  result: Record<string, unknown>,
  manifest: HostSourceManifest,
): readonly HostSourceObject[] => {
  if (kind === "er") return manifest.source_objects;
  if (!Array.isArray(result.questions)) throw new Error("KTQ result has no questions");
  const byPath = new Map(manifest.source_objects.map((item) => [item.workspace_path, item]));
  const selected = new Map<string, HostSourceObject>();
  for (const [index, candidate] of result.questions.entries()) {
    const question = record(candidate);
    const source = record(question?.source);
    if (!source) throw new Error(`KTQ question ${index} has no object-backed source`);
    const references = [source.path, ...(Array.isArray(question?.image_refs) ? question.image_refs : [])];
    for (const reference of references) {
      const workspacePath = parseSourcePath(reference);
      const item = byPath.get(workspacePath);
      if (!item) throw new Error(`KTQ question ${index} cites a source outside its host manifest`);
      selected.set(workspacePath, item);
    }
  }
  if (selected.size < 1) throw new Error("KTQ result has no object-backed sources");
  return [...selected.values()];
};
