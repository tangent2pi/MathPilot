import validateProblemDetails from "./generated/problem-details-validator.js";

/** Runtime projection of schemas/http/problem-details.schema.json.
 * The JSON Schema remains the authoritative output contract. */
export interface ProblemDetails {
  type: `urn:mathpilot:problem:${string}`;
  title: string;
  status: number;
  code: string;
  detail?: string;
  current_version?: number;
}

export function isProblemDetails(value: unknown): value is ProblemDetails {
  return validateProblemDetails(value) as boolean;
}

export interface ProblemResponse {
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  readonly body?: { cancel(reason?: unknown): Promise<void> } | null;
  json(): Promise<unknown>;
}

/** Decode the canonical wire contract without depending on browser DOM types. */
export async function readProblemDetails(response: ProblemResponse): Promise<ProblemDetails | undefined> {
  const mediaType = response.headers.get("content-type")?.split(";",1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/problem+json") {
    await response.body?.cancel().catch(() => undefined);
    return undefined;
  }
  const body = await response.json().catch(() => undefined);
  return isProblemDetails(body) && body.status===response.status ? body : undefined;
}

/** Select a public diagnostic; server-side detail is never displayed for 5xx failures. */
export function publicProblemMessage(problem: ProblemDetails): string {
  return problem.status < 500 ? problem.detail ?? problem.title : problem.title;
}
