import { createHash, randomBytes } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const ARTIFACT_ID = /^art_[A-Za-z0-9]{8,92}$/;
const ALLOWED_EXTENSIONS = new Set([".html", ".json", ".md", ".css", ".js", ".svg", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".mp4", ".webm", ".woff", ".woff2"]);
const ALLOWED_KINDS = new Set(["knowledge_visualization", "question_card", "mixed_lesson"]);
const ALLOWED_RENDERERS = new Set(["native_card", "media"]);
const ACTIVE_ARTIFACT_EXTENSIONS = new Set([".html", ".js", ".svg"]);
const MIME_BY_EXTENSION: Record<string, string> = {
  ".html": "text/html", ".json": "application/json", ".md": "text/markdown",
  ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".gif": "image/gif", ".mp4": "video/mp4", ".webm": "video/webm", ".woff": "font/woff", ".woff2": "font/woff2",
};

export function publishedArtifactContentType(extension: string): string | null {
  const normalized = extension.toLowerCase();
  if (ACTIVE_ARTIFACT_EXTENSIONS.has(normalized)) return null;
  const mime = MIME_BY_EXTENSION[normalized];
  if (!mime) return null;
  return mime.startsWith("text/") || mime === "application/json" ? `${mime}; charset=utf-8` : mime;
}

interface ArtifactManifest {
  schema: string;
  artifact_id: string;
  session_id: string;
  kind: string;
  renderer: string;
  title: string;
  entry: string;
  files: { path: string; mime_type: string; byte_size: number; content_hash: string }[];
  response_policy: { required: boolean; allow_skip: boolean; allow_free_text_without_answer: boolean };
  source_refs?: string[];
  generator?: Record<string, string>;
}

export interface PublishedArtifact {
  artifact_id: string;
  kind: "question_card" | "image" | "video";
  artifact_kind: string;
  renderer: string;
  title: string;
  artifact_ref: string;
  uri: string;
  entrypoint: string;
  manifest_hash: string;
  interaction_token: string;
  manifest: ArtifactManifest;
}

function safeRelative(value: string): string {
  if (!value || path.isAbsolute(value)) throw new Error("artifact path must be relative");
  const normalized = path.normalize(value);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) throw new Error("artifact path escapes root");
  return normalized;
}

async function collectFiles(root: string, directory = root): Promise<{ relative: string; size: number; hash: string }[]> {
  const files: { relative: string; size: number; hash: string }[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink()) throw new Error("artifact symlinks are forbidden");
    if (entry.isDirectory()) files.push(...await collectFiles(root, absolute));
    else if (entry.isFile()) {
      const relative = path.relative(root, absolute);
      if (!ALLOWED_EXTENSIONS.has(path.extname(relative).toLowerCase())) throw new Error(`artifact file type is not allowed: ${relative}`);
      files.push({ relative, size: stat.size, hash: createHash("sha256").update(await readFile(absolute)).digest("hex") });
    }
    if (files.length > 200) throw new Error("artifact exceeds 200 files");
  }
  if (files.reduce((sum, file) => sum + file.size, 0) > 64 * 1024 * 1024) throw new Error("artifact exceeds 64 MiB");
  return files.sort((a, b) => a.relative.localeCompare(b.relative));
}

function validateBrowserText(text: string): void {
  const forbidden = [/<base\b/i, /<form\b/i, /https?:\/\//i, /(?:src|href)\s*=\s*["']\/\//i, /\bfetch\s*\(/i,
    /XMLHttpRequest/i, /WebSocket/i, /EventSource/i, /sendBeacon/i, /localStorage/i, /sessionStorage/i,
    /indexedDB/i, /document\.cookie/i, /@import\b/i];
  if (forbidden.some((pattern) => pattern.test(text))) throw new Error("sandboxed artifact requests network, storage, forms, or cookie access");
}

function validateMagic(extension: string, bytes: Buffer): void {
  const ascii = bytes.subarray(0, 16).toString("ascii");
  const valid = extension === ".png" ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : [".jpg", ".jpeg"].includes(extension) ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    : extension === ".gif" ? ascii.startsWith("GIF87a") || ascii.startsWith("GIF89a")
    : extension === ".webp" ? ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP"
    : extension === ".mp4" ? ascii.slice(4, 8) === "ftyp"
    : extension === ".webm" ? bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
    : extension === ".woff" ? ascii.startsWith("wOFF")
    : extension === ".woff2" ? ascii.startsWith("wOF2") : true;
  if (!valid) throw new Error(`artifact content does not match extension: ${extension}`);
}

function validatePassiveArtifactFile(extension: string, bytes: Buffer): void {
  if (!ALLOWED_EXTENSIONS.has(extension) || ACTIVE_ARTIFACT_EXTENSIONS.has(extension)) {
    throw new Error(`active or unsupported artifact file type is forbidden: ${extension}`);
  }
  if (extension === ".css") validateBrowserText(bytes.toString("utf8"));
  else validateMagic(extension, bytes);
}

function validatePolicy(policy: ArtifactManifest["response_policy"]): void {
  if (!policy || policy.required !== false || policy.allow_skip !== true || policy.allow_free_text_without_answer !== true) {
    throw new Error("artifact response_policy violates the optional-card contract");
  }
}

function validateQuestionCard(raw: string, artifactId: string): void {
  const card = JSON.parse(raw) as Record<string, unknown>;
  if (card.schema !== "mathpilot.question-card/v1" || card.artifact_id !== artifactId) throw new Error("invalid question card identity");
  if (typeof card.card_id !== "string" || !/^card_[A-Za-z0-9]+$/.test(card.card_id)) throw new Error("invalid question card id");
  if (!["single_choice", "multiple_choice", "fill_blank", "true_false", "short_answer"].includes(String(card.type))) throw new Error("invalid question card type");
  if (typeof card.prompt !== "string" || !card.prompt.trim()) throw new Error("question card prompt required");
  if (!["teaching_only", "eligible_if_independent"].includes(String(card.evidence_policy))) throw new Error("invalid question card evidence policy");
  validatePolicy(card.response_policy as ArtifactManifest["response_policy"]);
}

function browserKind(manifest: ArtifactManifest, entry: string): PublishedArtifact["kind"] {
  if (manifest.renderer === "native_card") return "question_card";
  return [".mp4", ".webm"].includes(path.extname(entry).toLowerCase()) ? "video" : "image";
}

export async function publishWorkspaceArtifacts(workspaceRoot: string, sessionRef: string, requestedArtifactId?: string): Promise<PublishedArtifact[]> {
  const candidatesRoot = path.join(workspaceRoot, "output", "artifacts");
  const publishedRoot = path.join(workspaceRoot, ".agent", "published");
  const entries = await readdir(candidatesRoot, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const indexFile = path.join(workspaceRoot, ".agent", "published-artifacts.json");
  const prior = JSON.parse(await readFile(indexFile, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "[]";
    throw error;
  })) as PublishedArtifact[];
  const indexed = new Map(prior.map((artifact) => [artifact.artifact_id, artifact]));
  const published: PublishedArtifact[] = [];
  await mkdir(publishedRoot, { recursive: true });

  for (const directory of requestedArtifactId ? entries.filter((entry) => entry.name === requestedArtifactId) : entries.slice(0, 8)) {
    if (!directory.isDirectory() || !ARTIFACT_ID.test(directory.name)) continue;
    const source = path.join(candidatesRoot, directory.name);
    if (!(await realpath(source)).startsWith(`${await realpath(candidatesRoot)}${path.sep}`)) throw new Error("artifact directory escapes output root");
    const manifest = JSON.parse(await readFile(path.join(source, "manifest.json"), "utf8")) as ArtifactManifest;
    if (manifest.schema !== "mathpilot.learning-artifact/v1" || manifest.artifact_id !== directory.name || manifest.session_id !== sessionRef) throw new Error(`invalid artifact manifest identity: ${directory.name}`);
    if (!ALLOWED_KINDS.has(manifest.kind) || !ALLOWED_RENDERERS.has(manifest.renderer)) throw new Error(`invalid artifact type: ${directory.name}`);
    if (!manifest.title || manifest.title.length > 160) throw new Error(`invalid artifact title: ${directory.name}`);
    validatePolicy(manifest.response_policy);
    const entry = safeRelative(manifest.entry);
    if (manifest.renderer === "native_card" && entry !== "card.json") throw new Error("native card entry must be card.json");
    if (manifest.renderer === "media" && !entry.startsWith(`media${path.sep}`)) throw new Error("media entry must be below media/");
    const entryStat = await lstat(path.join(source, entry));
    if (!entryStat.isFile() || entryStat.isSymbolicLink()) throw new Error(`invalid artifact entrypoint: ${directory.name}`);

    const files = await collectFiles(source);
    const payload = files.filter((file) => file.relative !== "manifest.json");
    if (!Array.isArray(manifest.files) || manifest.files.length !== payload.length) throw new Error("manifest file inventory does not match artifact");
    const declarations = new Map(manifest.files.map((file) => [safeRelative(file.path), file]));
    if (declarations.size !== manifest.files.length) throw new Error("duplicate manifest file path");
    for (const file of payload) {
      const declared = declarations.get(file.relative);
      const extension = path.extname(file.relative).toLowerCase();
      if (!declared || declared.byte_size !== file.size || declared.content_hash !== `sha256:${file.hash}` || declared.mime_type !== MIME_BY_EXTENSION[extension]) throw new Error(`manifest metadata mismatch: ${file.relative}`);
      const bytes = await readFile(path.join(source, file.relative));
      validatePassiveArtifactFile(extension, bytes);
    }
    if (!declarations.has(entry)) throw new Error("manifest entry is absent from file inventory");
    if (manifest.renderer === "native_card") validateQuestionCard(await readFile(path.join(source, entry), "utf8"), directory.name);

    const hash = `sha256:${createHash("sha256").update(JSON.stringify({ manifest, files })).digest("hex")}`;
    const previous = indexed.get(directory.name);
    if (previous?.manifest_hash === hash) continue;
    if (previous) throw new Error(`artifact id is immutable and already published: ${directory.name}`);
    const destination = path.join(publishedRoot, directory.name);
    await rm(destination, { recursive: true, force: true });
    await cp(source, destination, { recursive: true, errorOnExist: true, force: false });
    const descriptor: PublishedArtifact = {
      artifact_id: directory.name, kind: browserKind(manifest, entry), artifact_kind: manifest.kind,
      renderer: manifest.renderer, title: manifest.title, artifact_ref: `artifact://${sessionRef}/${directory.name}`,
      uri: `/api/pi/threads/${encodeURIComponent(sessionRef)}/artifacts/${encodeURIComponent(directory.name)}/${entry.split(path.sep).map(encodeURIComponent).join("/")}`,
      entrypoint: entry, manifest_hash: hash, interaction_token: randomBytes(24).toString("base64url"), manifest,
    };
    indexed.set(directory.name, descriptor);
    published.push(descriptor);
  }
  await writeFile(indexFile, JSON.stringify([...indexed.values()], null, 2), "utf8");
  return published;
}

export async function readPublishedArtifact(workspaceRoot: string, artifactId: string, filePath: string): Promise<{ bytes: Buffer; extension: string } | null> {
  if (!ARTIFACT_ID.test(artifactId)) return null;
  const index = JSON.parse(await readFile(path.join(workspaceRoot, ".agent", "published-artifacts.json"), "utf8")) as PublishedArtifact[];
  const artifact = index.find((candidate) => candidate.artifact_id === artifactId);
  if (!artifact || !ALLOWED_RENDERERS.has(artifact.renderer) || !artifact.manifest || !ALLOWED_RENDERERS.has(artifact.manifest.renderer)) return null;
  const root = path.join(workspaceRoot, ".agent", "published", artifactId);
  const target = path.join(root, safeRelative(filePath));
  const rootReal = await realpath(root), targetReal = await realpath(target);
  if (!targetReal.startsWith(`${rootReal}${path.sep}`)) return null;
  const stat = await lstat(targetReal);
  if (!stat.isFile() || stat.isSymbolicLink()) return null;
  const bytes = await readFile(targetReal);
  const extension = path.extname(targetReal).toLowerCase();
  try {
    validatePassiveArtifactFile(extension, bytes);
  } catch {
    return null;
  }
  return { bytes, extension };
}
