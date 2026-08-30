import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readHostPrincipal } from "./lib/host-principal.ts";

const CONTENT_URL = (process.env.CONTENT_LIBRARY_URL ?? process.env.CONTENT_URL ?? "http://content:3006").replace(/\/$/, "");
const CONTENT_SECRET = process.env.CONTENT_LIBRARY_SECRET ?? process.env.PI_GATEWAY_SECRET ?? "";
const MAX_LIMIT = 50;

const entityKind = Type.Union([
  Type.Literal("knowledge"),
  Type.Literal("question_type"),
  Type.Literal("question"),
  Type.Literal("error_cause"),
  Type.Literal("diagnosis_rule"),
]);
const entityKinds = Type.Optional(Type.Array(entityKind, { minItems: 1, maxItems: 5, uniqueItems: true }));
const entityRef = Type.Optional(Type.String({ pattern: "^(knowledge|question_type|question|error_cause|diagnosis_rule):[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$" }));
const packageRef = Type.Optional(Type.String({ pattern: "^package:[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$" }));

type LibraryResponse = { items?: unknown[]; entity?: unknown; error?: unknown };

const requestLibrary = async (
  cwd: string,
  route: string,
  init?: RequestInit,
): Promise<LibraryResponse> => {
  const principal = await readHostPrincipal(cwd);
  const response = await fetch(`${CONTENT_URL}${route}`, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      accept: "application/json",
      "x-tenant-id": principal.tenantId,
      "x-user-id": principal.userId,
      "x-user-roles": principal.roles.join(","),
      ...(CONTENT_SECRET ? { "x-mathpilot-runtime-secret": CONTENT_SECRET } : {}),
    },
    signal: init?.signal ?? AbortSignal.timeout(15_000),
  });
  const body = await response.json().catch(() => ({})) as LibraryResponse;
  if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : `content library request failed (${response.status})`);
  return body;
};

export default function contentLibraryExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "content_library_search",
    label: "Content library search",
    description: "Search the tenant-scoped K/T/Q/E/R library. Scope and identity are injected by the host; never ask for or provide tenant, user, class, SQL, or raw scope parameters.",
    promptSnippet: "Search the scoped MathPilot content library",
    promptGuidelines: [
      "Use content_library_search before creating K/T/Q/E/R identifiers so matching entities can be reused.",
      "content_library_search only accepts entity_kinds, a semantic query, a cursor, and a small result limit; do not invent scope or database parameters.",
    ],
    parameters: Type.Object({
      entity_kinds: entityKinds,
      query: Type.Optional(Type.String({ maxLength: 240 })),
      cursor: Type.Optional(Type.String({ pattern: "^[0-9]+$" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_LIMIT })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, context) {
      const search = new URLSearchParams();
      for (const kind of params.entity_kinds ?? []) search.append("entity_kinds", kind);
      if (params.query?.trim()) search.set("query", params.query.trim());
      if (params.cursor) search.set("cursor", params.cursor);
      search.set("limit", String(Math.min(params.limit ?? 20, MAX_LIMIT)));
      const result = await requestLibrary(context.cwd, `/agent/library/search?${search.toString()}`, signal ? { signal } : undefined);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "content_library_get",
    label: "Get library entity",
    description: "Read one host-authorized K/T/Q/E/R entity by kind and entity reference. The host enforces tenant and visibility; no SQL or arbitrary IDs are accepted beyond the entity reference.",
    promptSnippet: "Read one entity from the scoped content library",
    promptGuidelines: [
      "Use content_library_get only after content_library_search or when a user supplied a concrete entity reference.",
      "content_library_get accepts exactly one entity_ref or package_ref; it cannot read arbitrary files or tables.",
    ],
    parameters: Type.Object({
      entity_ref: entityRef,
      package_ref: packageRef,
    }),
    async execute(_toolCallId, params, signal, _onUpdate, context) {
      if ((params.entity_ref ? 1 : 0) + (params.package_ref ? 1 : 0) !== 1) {
        throw new Error("exactly one entity_ref or package_ref is required");
      }
      const reference = params.entity_ref ?? params.package_ref;
      if (typeof reference !== "string") throw new Error("entity reference must be a string");
      const result = await requestLibrary(
        context.cwd,
        `/agent/library/get?${params.entity_ref ? "entity_ref" : "package_ref"}=${encodeURIComponent(reference)}`,
        signal ? { signal } : undefined,
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result,
      };
    },
  });
}
