import {
  InternalAssertionCodec,
  InternalServiceAssertionError,
  canonicalInternalPath,
  type AssertionRuntimeOptions,
  type InternalRequestBinding,
} from "./assertion.ts";
import {
  loadInternalServiceConfiguration,
  type InternalServiceConfiguration,
} from "./config.ts";
import { internalEdge, type InternalEdgeId, type InternalServiceId } from "./topology.ts";
import type {
  InternalActor,
  InternalIdentityEvent,
  InternalIdentityObserver,
  InternalServiceContext,
  InternalServiceReadiness,
} from "./types.ts";

type EnvironmentSource = Readonly<Record<string, string | undefined>>;

const RESERVED_HEADERS = new Set([
  "authorization",
  "host",
  "content-length",
  "x-mathpilot-gateway-secret",
  "x-mathpilot-runtime-secret",
  "x-tenant-id",
  "x-user-id",
  "x-user-roles",
]);

export interface InternalRequestOptions {
  method?: string;
  json?: unknown;
  headers?: Readonly<Record<string, string>>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface InternalRuntimeOptions extends Omit<AssertionRuntimeOptions, "observe"> {
  observe?: InternalIdentityObserver;
}

export class InternalServiceRuntime {
  readonly #codec: InternalAssertionCodec;
  readonly #observations = new Map<string, number>();
  readonly #observe: InternalIdentityObserver;

  constructor(
    readonly configuration: InternalServiceConfiguration,
    options: InternalRuntimeOptions = {},
  ) {
    this.#observe = (event) => {
      const key = [event.code, event.edge ?? "none", event.keyId ?? "none", event.reason ?? "none"].join(":");
      this.#observations.set(key, (this.#observations.get(key) ?? 0) + 1);
      try { options.observe?.(event); }
      catch { /* Telemetry cannot become an authentication dependency. */ }
    };
    this.#codec = new InternalAssertionCodec(configuration, { ...options, observe: this.#observe });
  }

  get service(): InternalServiceId { return this.configuration.service; }

  readiness(): InternalServiceReadiness {
    const outgoing: Array<{ edge: InternalEdgeId; activeKeyId: string }> = [];
    const incoming: Array<{ edge: InternalEdgeId; acceptedKeyIds: readonly string[] }> = [];
    for (const [edgeId, keyring] of this.configuration.keyrings) {
      if (keyring.edge.caller === this.service) outgoing.push({ edge: edgeId, activeKeyId: keyring.activeKeyId });
      if (keyring.edge.audience === this.service) incoming.push({ edge: edgeId, acceptedKeyIds: [...keyring.keys.keys()].sort() });
    }
    return Object.freeze({
      state: "ready",
      service: this.service,
      environment: this.configuration.environment,
      outgoing: Object.freeze(outgoing.sort((a, b) => a.edge.localeCompare(b.edge))),
      incoming: Object.freeze(incoming.sort((a, b) => a.edge.localeCompare(b.edge))),
      replayProtection: "memory-single-replica",
    });
  }

  observations(): Readonly<Record<string, number>> {
    return Object.freeze(Object.fromEntries(this.#observations));
  }

  async authenticate(
    allowedEdges: readonly InternalEdgeId[],
    authorization: unknown,
    binding: InternalRequestBinding,
  ): Promise<InternalServiceContext> {
    return this.#codec.verify(allowedEdges, authorization, binding);
  }

  async request(
    edgeId: InternalEdgeId,
    actor: InternalActor,
    pathValue: string,
    options: InternalRequestOptions = {},
  ): Promise<Response> {
    const edge = internalEdge(edgeId);
    if (edge.caller !== this.service) throw new InternalServiceAssertionError("caller_edge_mismatch");
    const baseUrl = this.configuration.targetUrls.get(edge.audience);
    if (!baseUrl) throw new InternalServiceAssertionError("target_not_configured");
    const path = canonicalInternalPath(pathValue);
    const method = (options.method ?? "GET").toUpperCase();
    const hasJson = Object.hasOwn(options, "json");
    const binding = { method, path, ...(hasJson ? { body: options.json } : {}) };
    const assertion = await this.#codec.issue(edgeId, actor, binding);
    const headers = new Headers();
    for (const [name, value] of Object.entries(options.headers ?? {})) {
      if (RESERVED_HEADERS.has(name.toLowerCase())) throw new InternalServiceAssertionError("reserved_header");
      headers.set(name, value);
    }
    headers.set("authorization", `Bearer ${assertion}`);
    headers.set("accept", headers.get("accept") ?? "application/json");
    let body: string | undefined;
    if (hasJson) {
      try { body = JSON.stringify(options.json); }
      catch { throw new InternalServiceAssertionError("invalid_json_body"); }
      if (body === undefined) throw new InternalServiceAssertionError("invalid_json_body");
      headers.set("content-type", "application/json");
    }
    const timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15 * 60_000) {
      throw new InternalServiceAssertionError("invalid_timeout");
    }
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    try {
      return await fetch(`${baseUrl}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body }),
        redirect: "error",
        signal,
      });
    } catch (error) {
      this.#observe({ code: "request_failed", service: this.service, edge: edgeId, reason: error instanceof Error ? error.name : "unknown" });
      throw error;
    }
  }
}

export function createInternalServiceRuntime(
  service: InternalServiceId,
  source: EnvironmentSource,
  options: InternalRuntimeOptions = {},
): InternalServiceRuntime {
  return new InternalServiceRuntime(loadInternalServiceConfiguration(service, source), options);
}

const REGISTRY_SYMBOL = Symbol.for("mathpilot.internal-service.runtime-registry/v1");
type RuntimeRegistry = Map<InternalServiceId, InternalServiceRuntime>;
const globalRegistry = globalThis as typeof globalThis & { [REGISTRY_SYMBOL]?: RuntimeRegistry };

const registry = (): RuntimeRegistry => globalRegistry[REGISTRY_SYMBOL] ??= new Map();

export function configureInternalService(
  service: InternalServiceId,
  source: EnvironmentSource = process.env,
  options: InternalRuntimeOptions = {},
): InternalServiceRuntime {
  if (registry().has(service)) throw new Error(`${service} internal service runtime is already configured`);
  const runtime = createInternalServiceRuntime(service, source, options);
  registry().set(service, runtime);
  return runtime;
}

export function configuredInternalService(service: InternalServiceId): InternalServiceRuntime {
  const runtime = registry().get(service);
  if (!runtime) throw new Error(`${service} internal service runtime has not been configured`);
  return runtime;
}

export function resetInternalServiceRegistryForTests(): void {
  registry().clear();
}

export type { InternalIdentityEvent };
