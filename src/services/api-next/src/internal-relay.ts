import type { FastifyReply, FastifyRequest } from "fastify";
import type {
  InternalActor,
  InternalEdgeId,
  InternalServiceRuntime,
} from "@mathpilot/internal-service";
import { isProblemDetails, sendProblem } from "@mathpilot/internal-service/fastify";

const successfulResponseHeaders = [
  "content-type",
  "content-disposition",
  "cache-control",
  "etag",
  "last-modified",
] as const;

function forwardProblemSemantics(response: Response, reply: FastifyReply): void {
  reply.type("application/problem+json").header("cache-control", "no-store");
  const retryAfter = response.headers.get("retry-after");
  // Internal services use delay-seconds. HTTP-date support is deliberately not
  // promised until a consumer requires it and a standards parser owns it.
  if (response.status === 429 && retryAfter && /^[0-9]{1,10}$/.test(retryAfter)) {
    reply.header("retry-after", retryAfter);
  }
  const challenge = response.headers.get("www-authenticate");
  if (response.status === 401 && challenge) reply.header("www-authenticate", challenge);
}

function isProblemBody(bytes: Buffer, status: number): boolean {
  try {
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    return isProblemDetails(value) && value.status === status;
  } catch {
    return false;
  }
}

const relay = async (
  runtime: InternalServiceRuntime,
  edge: InternalEdgeId,
  actor: InternalActor,
  path: string,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> => {
  const includesBody = request.body !== undefined && !["GET", "HEAD"].includes(request.method);
  const cancellation = new AbortController();
  const abort = () => cancellation.abort(new Error("upstream request was aborted"));
  const close = () => {
    if (!reply.raw.writableFinished) abort();
  };
  if (request.raw.aborted) abort();
  else request.raw.once("aborted", abort);
  reply.raw.once("close", close);
  try {
    // OCR 作业可能轮询数分钟；教师对话需要等待 Pi 完整一轮（问题目/讲解）；
    // 组卷答案解析的 AI 补全与 XeLaTeX 出片同样耗时；其余 content 转发保持默认 30s。
    const timeoutMs = path.startsWith("/ocr") || path.startsWith("/teacher-chat") || path.includes("/answer") ? 600_000 : 30_000;
    const response = await runtime.request(edge, actor, path, {
      method: request.method,
      ...(includesBody ? { json: request.body } : {}),
      signal: cancellation.signal,
      timeoutMs,
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    const responseType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (response.status >= 400) {
      if (responseType !== "application/problem+json" || !isProblemBody(bytes, response.status)) {
        request.log.error({ upstreamStatus: response.status, edge }, "internal service returned a non-conforming error");
        return sendProblem(reply, {
          status: 502,
          code: "invalid_upstream_response",
          title: "Internal service returned an invalid response",
        });
      }
      reply.code(response.status);
      forwardProblemSemantics(response, reply);
      return reply.send(bytes);
    }
    reply.code(response.status);
    for (const name of successfulResponseHeaders) {
      const value = response.headers.get(name);
      if (value) reply.header(name, value);
    }
    return reply.send(bytes);
  } finally {
    request.raw.removeListener("aborted", abort);
    reply.raw.removeListener("close", close);
  }
};

export const relayContent = (
  runtime: InternalServiceRuntime,
  actor: InternalActor,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> => {
  const suffix = request.url.replace(/^\/api\/content(?=\/|$)/, "") || "/";
  return relay(runtime, "api-to-content", actor, suffix, request, reply);
};

export const relayStorage = (
  runtime: InternalServiceRuntime,
  actor: InternalActor,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> => {
  const suffix = request.url.replace(/^\/api\/storage(?=\/|$)/, "") || "/";
  return relay(runtime, "api-to-storage", actor, `/internal${suffix}`, request, reply);
};
