import { sendProblem } from "@mathpilot/internal-service/fastify";
import type { FastifyReply } from "fastify";

function copyProviderHeaders(reply: FastifyReply, response: Response, includeAll: boolean): void {
  if (includeAll) {
    response.headers.forEach((value, key) => {
      if (key !== "set-cookie" && key !== "content-length") reply.header(key, value);
    });
  }
  const cookies = response.headers.getSetCookie();
  if (cookies.length) reply.header("set-cookie", cookies);
}

// Better Auth owns its SDK-facing 4xx wire format. This adapter only supplies
// the HTTP safety properties that belong to MathPilot's outer boundary.
export async function forwardBetterAuthResponse(reply: FastifyReply, response: Response): Promise<FastifyReply> {
  copyProviderHeaders(reply, response, response.status < 500);
  if (response.status >= 500) {
    return sendProblem(reply, {
      status: 500,
      code: "authentication_service_failed",
      title: "Authentication service failed",
    });
  }

  reply.code(response.status);
  if (!response.ok) reply.header("cache-control", "no-store");
  if (response.status === 429) {
    const retryAfter = response.headers.get("x-retry-after");
    if (retryAfter && /^\d+$/.test(retryAfter)) reply.header("retry-after", retryAfter);
  }
  return reply.send(await response.text() || null);
}
