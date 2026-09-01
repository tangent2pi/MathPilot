import { createHash, randomUUID } from "node:crypto";
import canonicalize from "canonicalize";
import { SignJWT, base64url, decodeProtectedHeader, jwtVerify } from "jose";
import { z } from "zod";
import {
  isValidInternalKeyId,
  type InternalEdgeKeyring,
  type InternalServiceConfiguration,
} from "./config.ts";
import { internalEdge, serviceIssuer, type InternalEdgeId } from "./topology.ts";
import type { InternalActor, InternalIdentityObserver, InternalServiceContext } from "./types.ts";

const ASSERTION_ALGORITHM = "HS256";
const ASSERTION_TYPE = "mathpilot-internal+jwt";
const ASSERTION_TTL_SECONDS = 60;
const CLOCK_TOLERANCE_SECONDS = 5;
const MAX_ASSERTION_BYTES = 8192;

const actorSchema = z.object({
  sub: z.string().min(1).max(160),
  mathpilot_tenant_id: z.string().min(1).max(160),
  mathpilot_roles: z.array(z.enum(["student", "teacher"])).min(1).max(2),
  mathpilot_edge: z.string().min(1).max(64),
  mathpilot_method: z.string().min(1).max(16),
  mathpilot_path: z.string().min(1).max(4096),
  mathpilot_body_sha256: z.string().length(43),
  iss: z.string().min(1),
  aud: z.union([z.string(), z.array(z.string()).min(1)]),
  iat: z.number().int().nonnegative(),
  exp: z.number().int().positive(),
  jti: z.string().uuid(),
}).passthrough();

export interface InternalRequestBinding {
  method: string;
  path: string;
  body?: unknown;
}

export interface ReplayStore {
  consume(edge: InternalEdgeId, assertionId: string, expiresAt: number, now: number): Promise<boolean>;
}

export class MemoryReplayStore implements ReplayStore {
  readonly mode = "memory-single-replica" as const;
  readonly #entries = new Map<string, number>();

  constructor(private readonly maximumEntries = 100_000) {}

  async consume(edge: InternalEdgeId, assertionId: string, expiresAt: number, now: number): Promise<boolean> {
    for (const [key, expiry] of this.#entries) if (expiry + CLOCK_TOLERANCE_SECONDS < now) this.#entries.delete(key);
    const key = `${edge}\u0000${assertionId}`;
    if (this.#entries.has(key) || this.#entries.size >= this.maximumEntries) return false;
    this.#entries.set(key, expiresAt);
    return true;
  }
}

export class InternalServiceAssertionError extends Error {
  override readonly name = "InternalServiceAssertionError";
  constructor(readonly reason: string) { super("internal service assertion rejected"); }
}

const normalizedRoles = (roles: InternalActor["roles"]): ("student" | "teacher")[] =>
  [...new Set(roles)].filter((role): role is "student" | "teacher" => role === "student" || role === "teacher").sort();

const validateActor = (actor: InternalActor): InternalActor => {
  const tenantId = actor.tenantId.trim();
  const userId = actor.userId.trim();
  const roles = normalizedRoles(actor.roles);
  if (!tenantId || tenantId.length > 160 || !userId || userId.length > 160 || roles.length < 1) {
    throw new InternalServiceAssertionError("invalid_actor");
  }
  return Object.freeze({ tenantId, userId, roles });
};

export const canonicalInternalPath = (value: string): string => {
  if (!value.startsWith("/") || value.includes("#")) throw new InternalServiceAssertionError("invalid_path");
  const url = new URL(value, "http://mathpilot.internal");
  return `${url.pathname}${url.search}`;
};

export const canonicalJsonDigest = (body: unknown): string => {
  if (body === undefined) {
    return base64url.encode(createHash("sha256").update("mathpilot:no-json-body:v1", "utf8").digest());
  }
  let serialized: string | undefined;
  try {
    serialized = canonicalize(body);
  } catch {
    throw new InternalServiceAssertionError("invalid_json_body");
  }
  if (serialized === undefined) throw new InternalServiceAssertionError("invalid_json_body");
  return base64url.encode(createHash("sha256").update("mathpilot:json-body:v1\u0000", "utf8").update(serialized, "utf8").digest());
};

const normalizeBinding = (binding: InternalRequestBinding): Required<InternalRequestBinding> => {
  const method = binding.method.trim().toUpperCase();
  if (!/^[A-Z]{1,16}$/.test(method)) throw new InternalServiceAssertionError("invalid_method");
  return { method, path: canonicalInternalPath(binding.path), body: binding.body };
};

const keyIdentifier = (edge: InternalEdgeId, keyId: string): string => `${edge}:${keyId}`;

const keyringFor = (configuration: InternalServiceConfiguration, edgeId: InternalEdgeId): InternalEdgeKeyring => {
  const keyring = configuration.keyrings.get(edgeId);
  if (!keyring) throw new InternalServiceAssertionError("edge_not_configured");
  return keyring;
};

export interface AssertionRuntimeOptions {
  now?: () => number;
  assertionId?: () => string;
  replayStore?: ReplayStore;
  observe?: InternalIdentityObserver;
}

export class InternalAssertionCodec {
  readonly #now: () => number;
  readonly #assertionId: () => string;
  readonly #replayStore: ReplayStore;
  readonly #observe: InternalIdentityObserver;

  constructor(
    readonly configuration: InternalServiceConfiguration,
    options: AssertionRuntimeOptions = {},
  ) {
    this.#now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.#assertionId = options.assertionId ?? randomUUID;
    this.#replayStore = options.replayStore ?? new MemoryReplayStore();
    this.#observe = options.observe ?? (() => undefined);
  }

  async issue(edgeId: InternalEdgeId, actorValue: InternalActor, bindingValue: InternalRequestBinding): Promise<string> {
    const edge = internalEdge(edgeId);
    if (edge.caller !== this.configuration.service) throw new InternalServiceAssertionError("caller_edge_mismatch");
    const actor = validateActor(actorValue);
    const binding = normalizeBinding(bindingValue);
    const keyring = keyringFor(this.configuration, edgeId);
    const key = keyring.keys.get(keyring.activeKeyId);
    if (!key) throw new InternalServiceAssertionError("active_key_missing");
    const now = this.#now();
    const assertionId = this.#assertionId();
    const token = await new SignJWT({
      mathpilot_tenant_id: actor.tenantId,
      mathpilot_roles: actor.roles,
      mathpilot_edge: edge.id,
      mathpilot_method: binding.method,
      mathpilot_path: binding.path,
      mathpilot_body_sha256: canonicalJsonDigest(binding.body),
    })
      .setProtectedHeader({ alg: ASSERTION_ALGORITHM, typ: ASSERTION_TYPE, kid: keyIdentifier(edge.id, keyring.activeKeyId) })
      .setIssuer(serviceIssuer(edge.caller))
      .setAudience(serviceIssuer(edge.audience))
      .setSubject(actor.userId)
      .setIssuedAt(now)
      .setExpirationTime(now + ASSERTION_TTL_SECONDS)
      .setJti(assertionId)
      .sign(key);
    this.#observe({ code: "assertion_issued", service: this.configuration.service, edge: edge.id, keyId: keyring.activeKeyId });
    return token;
  }

  async verify(
    allowedEdges: readonly InternalEdgeId[],
    authorization: unknown,
    bindingValue: InternalRequestBinding,
  ): Promise<InternalServiceContext> {
    let selectedEdge: InternalEdgeId | undefined;
    let selectedKeyId: string | undefined;
    try {
      if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) throw new InternalServiceAssertionError("missing_bearer");
      const token = authorization.slice("Bearer ".length);
      if (!token || Buffer.byteLength(token, "utf8") > MAX_ASSERTION_BYTES) throw new InternalServiceAssertionError("invalid_token_size");
      const protectedHeader = decodeProtectedHeader(token);
      if (protectedHeader.alg !== ASSERTION_ALGORITHM || protectedHeader.typ !== ASSERTION_TYPE || typeof protectedHeader.kid !== "string") {
        throw new InternalServiceAssertionError("invalid_protected_header");
      }
      const separator = protectedHeader.kid.lastIndexOf(":");
      if (separator < 1) throw new InternalServiceAssertionError("invalid_key_id");
      const candidateEdge = protectedHeader.kid.slice(0, separator) as InternalEdgeId;
      const candidateKeyId = protectedHeader.kid.slice(separator + 1);
      if (!allowedEdges.includes(candidateEdge)) throw new InternalServiceAssertionError("edge_not_allowed");
      selectedEdge = candidateEdge;
      if (!isValidInternalKeyId(candidateKeyId)) throw new InternalServiceAssertionError("invalid_key_id");
      const edge = internalEdge(selectedEdge);
      if (edge.audience !== this.configuration.service) throw new InternalServiceAssertionError("audience_edge_mismatch");
      const keyring = keyringFor(this.configuration, selectedEdge);
      const key = keyring.keys.get(candidateKeyId);
      if (!key) throw new InternalServiceAssertionError("unknown_key_id");
      selectedKeyId = candidateKeyId;
      const now = this.#now();
      const result = await jwtVerify(token, key, {
        algorithms: [ASSERTION_ALGORITHM],
        issuer: serviceIssuer(edge.caller),
        audience: serviceIssuer(edge.audience),
        requiredClaims: ["iat", "exp", "iss", "aud", "sub", "jti"],
        maxTokenAge: `${ASSERTION_TTL_SECONDS + CLOCK_TOLERANCE_SECONDS}s`,
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
        currentDate: new Date(now * 1000),
      });
      const claims = actorSchema.parse(result.payload);
      const binding = normalizeBinding(bindingValue);
      if (claims.mathpilot_edge !== edge.id
        || claims.mathpilot_method !== binding.method
        || claims.mathpilot_path !== binding.path
        || claims.mathpilot_body_sha256 !== canonicalJsonDigest(binding.body)) {
        throw new InternalServiceAssertionError("request_binding_mismatch");
      }
      if (!await this.#replayStore.consume(edge.id, claims.jti, claims.exp, now)) {
        throw new InternalServiceAssertionError("assertion_replayed");
      }
      const context: InternalServiceContext = Object.freeze({
        edge: edge.id,
        caller: edge.caller,
        audience: edge.audience,
        actor: Object.freeze({
          tenantId: claims.mathpilot_tenant_id,
          userId: claims.sub,
          roles: Object.freeze([...new Set(claims.mathpilot_roles)].sort()),
        }),
        assertionId: claims.jti,
        issuedAt: claims.iat,
        expiresAt: claims.exp,
        keyId: selectedKeyId,
      });
      this.#observe({
        code: selectedKeyId === keyring.activeKeyId ? "assertion_verified" : "assertion_previous_key_verified",
        service: this.configuration.service,
        edge: edge.id,
        keyId: selectedKeyId,
      });
      return context;
    } catch (error) {
      const reason = error instanceof InternalServiceAssertionError ? error.reason : "invalid_assertion";
      this.#observe({
        code: "assertion_rejected",
        service: this.configuration.service,
        ...(selectedEdge ? { edge: selectedEdge } : {}),
        ...(selectedKeyId ? { keyId: selectedKeyId } : {}),
        reason,
      });
      if (error instanceof InternalServiceAssertionError) throw error;
      throw new InternalServiceAssertionError(reason);
    }
  }
}
