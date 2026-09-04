import type { FastifyReply, FastifyRequest } from "fastify";
import type {
  InternalActor,
  InternalEdgeId,
  InternalServiceRuntime,
} from "@mathpilot/internal-service";

const forwardedResponseHeaders = [
  "content-type",
  "content-disposition",
  "cache-control",
  "x-content-type-options",
] as const;

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
    reply.code(response.status);
    for (const name of forwardedResponseHeaders) {
      const value = response.headers.get(name);
      if (value) reply.header(name, value);
    }
    return reply.send(Buffer.from(await response.arrayBuffer()));
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
