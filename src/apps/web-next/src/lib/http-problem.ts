import { publicProblemMessage,readProblemDetails } from "@mathpilot/contracts";

export class HttpProblemError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly currentVersion?: number,
  ) {
    super(message);
  }
}

export async function responseProblem(response: Response, fallback = "请求失败"): Promise<HttpProblemError> {
  const problem = await readProblemDetails(response);
  return new HttpProblemError(
    problem ? publicProblemMessage(problem) : `${fallback}（${response.status}）`,
    response.status,
    problem?.code,
    problem?.current_version,
  );
}

export async function responseJson<T>(response: Response, fallback = "请求失败"): Promise<T> {
  if (!response.ok) throw await responseProblem(response, fallback);
  if (response.status === 204 || response.status === 205 || response.headers.get("content-length") === "0") {
    return undefined as T;
  }
  return response.json() as Promise<T>;
}
