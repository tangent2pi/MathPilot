import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiFetch, formatDate, jsonBody } from "../lib/api";

describe("api client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("parses successful JSON and always includes credentials", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(apiFetch<{ ok: boolean }>("/api/example")).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith("/api/example", { credentials: "include" });
  });

  it("turns API failures into typed errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "not_ready" }), { status: 409, headers: { "content-type": "application/json" } })));
    await expect(apiFetch("/api/example")).rejects.toMatchObject({ name: "ApiError", status: 409, message: "not_ready" } satisfies Partial<ApiError>);
  });

  it("builds JSON requests and keeps fallbacks predictable", () => {
    expect(jsonBody({ value: 1 })).toEqual({ headers: { "content-type": "application/json" }, body: '{"value":1}' });
    expect(formatDate(null)).toBe("—");
  });
});
