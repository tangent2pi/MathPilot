import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import type { InternalEdgeId } from "./topology.ts";
import type { InternalServiceContext } from "./types.ts";
import type { InternalServiceRuntime } from "./runtime.ts";

const contexts = new WeakMap<object, InternalServiceContext>();

const AUTHENTICATION_PROBLEM = Object.freeze({
  type: "urn:mathpilot:problem:internal-service-authentication",
  title: "Internal service authentication failed",
  status: 401,
  code: "internal_service_authentication_failed",
});

export function internalServiceGuard(
  runtime: InternalServiceRuntime,
  allowedEdges: readonly InternalEdgeId[],
): preHandlerHookHandler {
  const edges = Object.freeze([...allowedEdges]);
  return async (request, reply) => {
    try {
      const context = await runtime.authenticate(
        edges,
        request.headers.authorization,
        { method: request.method, path: request.url, body: request.body },
      );
      contexts.set(request, context);
    } catch {
      reply
        .header("www-authenticate", "Bearer")
        .type("application/problem+json")
        .code(401)
        .send(AUTHENTICATION_PROBLEM);
    }
  };
}

export function internalServiceContext(request: FastifyRequest): InternalServiceContext {
  const context = contexts.get(request);
  if (!context) throw new Error("internal service context is unavailable before authentication");
  return context;
}

export function sendInternalServiceAuthenticationFailure(reply: FastifyReply): FastifyReply {
  return reply
    .header("www-authenticate", "Bearer")
    .type("application/problem+json")
    .code(401)
    .send(AUTHENTICATION_PROBLEM);
}
