import { createHash, randomBytes } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

const MAX_FILES = 200;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const ARTIFACT_ID = /^art_[A-Za-z0-9]{8,92}$/;
const ALLOWED_EXTENSIONS = new Set([".html", ".json", ".md", ".css", ".js", ".svg", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".mp4", ".webm", ".woff", ".woff2"]);
const ALLOWED_KINDS = new Set(["knowledge_visualization", "question_card", "mixed_lesson"]);
const ALLOWED_RENDERERS = new Set(["native_card", "sandboxed_html", "media"]);

export interface PublishedArtifact {
  artifact_id: string;
  kind: "html" | "question_card" | "image" | "video";
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

const MIME_BY_EXTENSION: Record<string, string> = {
  ".html": "text/html", ".json": "application/json", ".md": "text/markdown",
  ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".webp": "image/webp", ".gif": "image/gif", ".mp4": "video/mp4",
  ".webm": "video/webm", ".woff": "font/woff", ".woff2": "font/woff2",
};

function safeRelative(value: string): string {
  if (!value || path.isAbsolute(value)) throw new Error("artifact path must be relative");
  const normalized = path.normalize(value);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) throw new Error("artifact path escapes root");
  return normalized;
}

async function collectFiles(root: string, current = root): Promise<{ relative: string; size: number; hash: string }[]> {
  const result: { relative: string; size: number; hash: string }[] = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const absolute = path.join(current, entry.name);
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink()) throw new Error("artifact symlinks are forbidden");
    if (entry.isDirectory()) result.push(...await collectFiles(root, absolute));
    else if (entry.isFile()) {
      const relative = path.relative(root, absolute);
      if (!ALLOWED_EXTENSIONS.has(path.extname(relative).toLowerCase())) throw new Error(`artifact file type is not allowed: ${relative}`);
      const bytes = await readFile(absolute);
      result.push({ relative, size: stat.size, hash: createHash("sha256").update(bytes).digest("hex") });
    }
    if (result.length > MAX_FILES) throw new Error(`artifact exceeds ${MAX_FILES} files`);
  }
  if (result.reduce((sum, file) => sum + file.size, 0) > MAX_TOTAL_BYTES) throw new Error("artifact exceeds 64 MiB");
  return result.sort((a, b) => a.relative.localeCompare(b.relative));
}

function validateBrowserText(text: string): void {
  const forbidden = [
    /<base\b/i, /<form\b/i, /https?:\/\//i, /(?:src|href)\s*=\s*["']\/\//i,
    /\bfetch\s*\(/i, /XMLHttpRequest/i, /WebSocket/i, /EventSource/i, /sendBeacon/i,
    /localStorage/i, /sessionStorage/i, /indexedDB/i, /document\.cookie/i, /@import\b/i,
  ];
  if (forbidden.some((pattern) => pattern.test(text))) throw new Error("sandboxed artifact requests network, storage, forms, or cookie access");
}

function validateSvg(svg: string): void {
  validateBrowserText(svg);
  if (/<script\b|<foreignObject\b|\son[a-z]+\s*=/i.test(svg)) throw new Error("active SVG content is forbidden");
}

function validateMagic(extension: string, bytes: Buffer): void {
  const ascii = bytes.subarray(0, 16).toString("ascii");
  const ok = extension === ".png" ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : [".jpg", ".jpeg"].includes(extension) ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    : extension === ".gif" ? ascii.startsWith("GIF87a") || ascii.startsWith("GIF89a")
    : extension === ".webp" ? ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP"
    : extension === ".mp4" ? ascii.slice(4, 8) === "ftyp"
    : extension === ".webm" ? bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
    : extension === ".woff" ? ascii.startsWith("wOFF")
    : extension === ".woff2" ? ascii.startsWith("wOF2")
    : true;
  if (!ok) throw new Error(`artifact content does not match extension: ${extension}`);
}

function validateResponsePolicy(policy: ArtifactManifest["response_policy"]): void {
  if (!policy || policy.required !== false || policy.allow_skip !== true || policy.allow_free_text_without_answer !== true) {
    throw new Error("artifact response_policy violates the optional-card contract");
  }
}

function validateQuestionCard(raw: string, artifactId: string): void {
  const card = JSON.parse(raw) as Record<string, unknown>;
  if (card.schema !== "mathpilot.question-card/v1" || card.artifact_id !== artifactId) throw new Error("invalid question card identity");
  if (typeof card.card_id !== "string" || !/^card_[A-Za-z0-9]+$/.test(card.card_id)) throw new Error("invalid question card id");
  if (!["single_choice", "multiple_choice", "fill_blank", "true_false"].includes(String(card.type))) throw new Error("invalid question card type");
  if (typeof card.prompt !== "string" || !card.prompt.trim()) throw new Error("question card prompt required");
  if (!["teaching_only", "eligible_if_independent"].includes(String(card.evidence_policy))) throw new Error("invalid question card evidence policy");
  validateResponsePolicy(card.response_policy as ArtifactManifest["response_policy"]);
}

function browserKind(manifest: ArtifactManifest, entrypoint: string): PublishedArtifact["kind"] {
  if (manifest.renderer === "native_card") return "question_card";
  if (manifest.renderer === "sandboxed_html") return "html";
  const ext = path.extname(entrypoint).toLowerCase();
  return [".mp4", ".webm"].includes(ext) ? "video" : "image";
}

export async function publishWorkspaceArtifacts(workspaceRoot: string, sessionRef: string): Promise<PublishedArtifact[]> {
  const candidatesRoot = path.join(workspaceRoot, "output", "artifacts");
  const publishedRoot = path.join(workspaceRoot, ".agent", "published");
  const entries = await readdir(candidatesRoot, { withFileTypes: true }).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return [];
    throw err;
  });
  const indexFile = path.join(workspaceRoot, ".agent", "published-artifacts.json");
  const prior = JSON.parse(await readFile(indexFile, "utf8").catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return "[]";
    throw err;
  })) as PublishedArtifact[];
  const indexed = new Map(prior.map((artifact) => [artifact.artifact_id, artifact]));
  const published: PublishedArtifact[] = [];
  await mkdir(publishedRoot, { recursive: true });
  for (const entry of entries.slice(0, 8)) {
    if (!entry.isDirectory() || !ARTIFACT_ID.test(entry.name)) continue;
    const source = path.join(candidatesRoot, entry.name);
    const sourceReal = await realpath(source);
    const candidatesReal = await realpath(candidatesRoot);
    if (!sourceReal.startsWith(`${candidatesReal}${path.sep}`)) throw new Error("artifact directory escapes output root");
    const rawManifest = await readFile(path.join(source, "manifest.json"), "utf8");
    const manifest = JSON.parse(rawManifest) as ArtifactManifest;
    if (manifest.schema !== "mathpilot.learning-artifact/v1" || manifest.artifact_id !== entry.name || manifest.session_id !== sessionRef) throw new Error(`invalid artifact manifest identity: ${entry.name}`);
    if (!manifest.kind || !ALLOWED_KINDS.has(manifest.kind)) throw new Error(`invalid artifact kind: ${entry.name}`);
    if (!manifest.renderer || !ALLOWED_RENDERERS.has(manifest.renderer)) throw new Error(`invalid artifact renderer: ${entry.name}`);
    if (!manifest.title || manifest.title.length > 160) throw new Error(`invalid artifact title: ${entry.name}`);
    validateResponsePolicy(manifest.response_policy);
    const entrypoint = safeRelative(manifest.entry);
    if (manifest.renderer === "native_card" && entrypoint !== "card.json") throw new Error("native card entry must be card.json");
    if (manifest.renderer === "sandboxed_html" && entrypoint !== "index.html") throw new Error("HTML entry must be index.html");
    if (manifest.renderer === "media" && !entrypoint.startsWith(`media${path.sep}`)) throw new Error("media entry must be below media/");
    const entrypointStat = await lstat(path.join(source, entrypoint));
    if (!entrypointStat.isFile() || entrypointStat.isSymbolicLink()) throw new Error(`invalid artifact entrypoint: ${entry.name}`);
    const files = await collectFiles(source);
    const payloadFiles = files.filter((file) => file.relative !== "manifest.json");
    if (!Array.isArray(manifest.files) || manifest.files.length !== payloadFiles.length) throw new Error("manifest file inventory does not match artifact");
    const declarations = new Map(manifest.files.map((file) => [safeRelative(file.path), file]));
    if (declarations.size !== manifest.files.length) throw new Error("duplicate manifest file path");
    for (const file of payloadFiles) {
      const declared = declarations.get(file.relative);
      const extension = path.extname(file.relative).toLowerCase();
      if (!declared || declared.byte_size !== file.size || declared.content_hash !== `sha256:${file.hash}` || declared.mime_type !== MIME_BY_EXTENSION[extension]) {
        throw new Error(`manifest metadata mismatch: ${file.relative}`);
      }
      const bytes = await readFile(path.join(source, file.relative));
      if ([".html", ".css", ".js"].includes(extension)) validateBrowserText(bytes.toString("utf8"));
      else if (extension === ".svg") validateSvg(bytes.toString("utf8"));
      else validateMagic(extension, bytes);
    }
    if (!declarations.has(entrypoint)) throw new Error("manifest entry is absent from file inventory");
    if (manifest.renderer === "native_card") validateQuestionCard(await readFile(path.join(source, entrypoint), "utf8"), entry.name);
    const manifestHash = createHash("sha256").update(JSON.stringify({ manifest, files })).digest("hex");
    const previous = indexed.get(entry.name);
    if (previous?.manifest_hash === `sha256:${manifestHash}`) continue;
    if (previous) throw new Error(`artifact id is immutable and already published: ${entry.name}`);
    const destination = path.join(publishedRoot, entry.name);
    await cp(source, destination, { recursive: true, errorOnExist: true, force: false });
    const interactionToken = randomBytes(24).toString("base64url");
    const descriptor: PublishedArtifact = {
      artifact_id: entry.name,
      kind: browserKind(manifest, entrypoint),
      artifact_kind: manifest.kind,
      renderer: manifest.renderer,
      title: manifest.title,
      artifact_ref: `artifact://${sessionRef}/${entry.name}`,
      uri: `/api/sessions/${encodeURIComponent(sessionRef)}/artifacts/${encodeURIComponent(entry.name)}/${entrypoint.split(path.sep).map(encodeURIComponent).join("/")}`,
      entrypoint,
      manifest_hash: `sha256:${manifestHash}`,
      interaction_token: interactionToken,
      manifest,
    };
    published.push(descriptor);
    indexed.set(entry.name, descriptor);
  }
  await writeFile(indexFile, JSON.stringify([...indexed.values()], null, 2), "utf8");
  return published;
}

export async function readPublishedArtifact(
  workspaceRoot: string,
  artifactId: string,
  filePath: string,
): Promise<{ bytes: Buffer; extension: string } | null> {
  if (!ARTIFACT_ID.test(artifactId)) return null;
  const published = JSON.parse(await readFile(path.join(workspaceRoot, ".agent", "published-artifacts.json"), "utf8")) as PublishedArtifact[];
  if (!published.some((artifact) => artifact.artifact_id === artifactId)) return null;
  const relative = safeRelative(filePath);
  const root = path.join(workspaceRoot, ".agent", "published", artifactId);
  const target = path.join(root, relative);
  const rootReal = await realpath(root), targetReal = await realpath(target);
  if (!targetReal.startsWith(`${rootReal}${path.sep}`)) return null;
  const stat = await lstat(targetReal);
  if (!stat.isFile() || stat.isSymbolicLink()) return null;
  return { bytes: await readFile(targetReal), extension: path.extname(targetReal).toLowerCase() };
}
