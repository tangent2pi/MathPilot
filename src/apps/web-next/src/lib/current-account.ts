import { responseJson } from "./http-problem";

export interface CurrentAccountResponse {
  uid: string;
  tenant_id: string;
  roles: string[];
  name: string;
  email: string;
}

export async function fetchCurrentAccount(
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<CurrentAccountResponse> {
  const response = await fetcher("/api/me", {
    credentials: "include",
    ...(signal ? { signal } : {}),
  });
  return responseJson<CurrentAccountResponse>(response, "无法读取当前账户");
}
