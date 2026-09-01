import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
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

export interface FastifyServiceRuntimeDependencies {
  createApp(options: { bodyLimit?: number }): FastifyInstance | Promise<FastifyInstance>;
}

const productionFastifyServiceRuntime: FastifyServiceRuntimeDependencies = {
  async createApp(options) {
    const Fastify = (await import("fastify")).default;
    return Fastify({
      logger: true,
      ...(options.bodyLimit === undefined ? {} : { bodyLimit: options.bodyLimit }),
    });
  },
};

export async function startFastifyService(options: {
  name: string;
  port: number;
  bodyLimit?: number;
  register: (app: FastifyInstance) => void | Promise<void>;
}, dependencies: FastifyServiceRuntimeDependencies = productionFastifyServiceRuntime): Promise<FastifyInstance> {
  const app = await dependencies.createApp(
    options.bodyLimit === undefined ? {} : { bodyLimit: options.bodyLimit },
  );
  try {
    app.get("/healthz", async () => ({ status: "ok", service: options.name }));
    app.get("/readyz", async () => ({ status: "ready", service: options.name }));
    await options.register(app);
    await app.listen({ host: "0.0.0.0", port: options.port });
    return app;
  } catch (startupError) {
    try {
      // Fastify owns lifecycle cleanup: close() invokes onClose even when the
      // listener never reached its listening state.
      await app.close();
    } catch (cleanupError) {
      throw new AggregateError(
        [startupError, cleanupError],
        `${options.name} startup and cleanup both failed`,
      );
    }
    throw startupError;
  }
}

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
