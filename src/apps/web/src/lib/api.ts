export class ApiError extends Error {
  readonly status: number;
  readonly payload: unknown;

  constructor(message: string, status: number, payload: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.payload = payload;
  }
}

export async function apiFetch<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, { ...init, credentials: "include" });
  const type = response.headers.get("content-type") ?? "";
  const payload = type.includes("application/json")
    ? await response.json().catch(() => null)
    : await response.text().catch(() => "");

  if (!response.ok) {
    const message = payload && typeof payload === "object" && "error" in payload
      ? String(payload.error)
      : `请求失败（${response.status}）`;
    throw new ApiError(message, response.status, payload);
  }
  return payload as T;
}

export function jsonBody(value: unknown): Pick<RequestInit, "headers" | "body"> {
  return {
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  };
}

export function formatDate(value: unknown, fallback = "—"): string {
  if (!value) return fallback;
  const date = new Date(String(value));
  return Number.isNaN(date.getTime())
    ? fallback
    : date.toLocaleString("zh-CN", { dateStyle: "medium", timeStyle: "short" });
}
