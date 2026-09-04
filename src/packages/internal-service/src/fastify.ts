import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import { isProblemDetails, type ProblemDetails } from "@mathpilot/contracts";
import type { InternalEdgeId } from "./topology.ts";
import type { InternalServiceContext } from "./types.ts";
import type { InternalServiceRuntime } from "./runtime.ts";

const contexts = new WeakMap<object, InternalServiceContext>();

const AUTHENTICATION_PROBLEM = Object.freeze({
  title: "Internal service authentication failed",
  status: 401,
  code: "internal_service_authentication_failed",
});

export type ProblemInput = Omit<ProblemDetails, "type">;
export type FastifyProblemMapper = (error: unknown) => ProblemInput | undefined;

export { isProblemDetails } from "@mathpilot/contracts";

const problemType = (code: string): ProblemDetails["type"] =>
  `urn:mathpilot:problem:${code.replaceAll("_", "-")}`;

export function sendProblem(reply: FastifyReply, problem: ProblemInput): FastifyReply {
  const candidate: ProblemDetails = {
    type: problemType(problem.code),
    title: problem.title,
    status: problem.status,
    code: problem.code,
    ...(problem.detail === undefined ? {} : { detail: problem.detail }),
    ...(problem.current_version === undefined ? {} : { current_version: problem.current_version }),
  };
  const body: ProblemDetails = isProblemDetails(candidate) ? candidate : {
    type: "urn:mathpilot:problem:internal-server-error",
    title: "Internal server error",
    status: 500,
    code: "internal_server_error",
  };
  if (body !== candidate) {
    reply.request.log.error("invalid Problem Details descriptor rejected");
  }
  return reply
    .header("cache-control", "no-store")
    .type("application/problem+json")
    .code(body.status)
    .send(body);
}

function builtInProblem(error: FastifyError): ProblemInput | undefined {
  if (error.code === "FST_ERR_CTP_BODY_TOO_LARGE") {
    return { title: "Request body is too large", status: 413, code: "request_body_too_large" };
  }
  if (error.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE") {
    return { title: "Unsupported media type", status: 415, code: "unsupported_media_type" };
  }
  if (error.validation) {
    return { title: "Request validation failed", status: 422, code: "request_validation_failed" };
  }
  if (error.code === "FST_ERR_CTP_INVALID_CONTENT_LENGTH") {
    return { title: "Request content length is invalid", status: 400, code: "invalid_content_length" };
  }
  if (error.code === "FST_ERR_CTP_EMPTY_JSON_BODY" || error.code === "FST_ERR_CTP_INVALID_JSON_BODY"
    || (error.statusCode === 400 && error instanceof SyntaxError)) {
    return { title: "Request body is not valid JSON", status: 400, code: "invalid_json_body" };
  }
  return undefined;
}

export function installProblemDetails(
  app: FastifyInstance,
  mapError?: FastifyProblemMapper,
  options: { installNotFound?: boolean } = {},
): void {
  if (options.installNotFound!==false) {
    app.setNotFoundHandler((_request, reply) => sendProblem(reply, {
      title: "Route not found",
      status: 404,
      code: "route_not_found",
    }));
  }
  app.setErrorHandler((error, request, reply) => {
    // Transport errors belong to this shared boundary and must not be hidden
    // by a service adapter with a catch-all domain fallback.
    const mapped = builtInProblem(error as FastifyError) ?? mapError?.(error);
    if (mapped) {
      if (mapped.status >= 500) request.log.error({ err: error, code: mapped.code }, "request failed");
      else request.log.info({ err: error, code: mapped.code }, "request rejected");
      return sendProblem(reply, mapped);
    }
    request.log.error({ err: error }, "unhandled request failure");
    return sendProblem(reply, {
      title: "Internal server error",
      status: 500,
      code: "internal_server_error",
    });
  });
}

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
  mapError?: FastifyProblemMapper;
  readiness?: () => boolean | Promise<boolean>;
  register: (app: FastifyInstance) => void | Promise<void>;
}, dependencies: FastifyServiceRuntimeDependencies = productionFastifyServiceRuntime): Promise<FastifyInstance> {
  const app = await dependencies.createApp(
    options.bodyLimit === undefined ? {} : { bodyLimit: options.bodyLimit },
  );
  try {
    installProblemDetails(app, options.mapError);
    app.get("/healthz", async () => ({ status: "ok", service: options.name }));
    app.get("/readyz", async (_request, reply) => {
      const ready = (await options.readiness?.()) ?? true;
      return reply.code(ready ? 200 : 503).send({
        status: ready ? "ready" : "not_ready",
        service: options.name,
      });
    });
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
      sendInternalServiceAuthenticationFailure(reply);
    }
  };
}

export function internalServiceContext(request: FastifyRequest): InternalServiceContext {
  const context = contexts.get(request);
  if (!context) throw new Error("internal service context is unavailable before authentication");
  return context;
}

export function sendInternalServiceAuthenticationFailure(reply: FastifyReply): FastifyReply {
  reply.header("www-authenticate", "Bearer");
  return sendProblem(reply, AUTHENTICATION_PROBLEM);
}
