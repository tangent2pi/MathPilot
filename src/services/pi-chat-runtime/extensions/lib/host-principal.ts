import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

export interface HostPrincipal {
  tenantId: string;
  userId: string;
  roles: readonly ("student" | "teacher")[];
  issuedAt: string;
}

const principalPath = (cwd: string): string =>
  path.join(path.dirname(path.resolve(cwd)), ".host-state", path.basename(path.resolve(cwd)), "principal.json");

export async function writeHostPrincipal(cwd: string, principal: Omit<HostPrincipal, "issuedAt">): Promise<void> {
  const file = principalPath(cwd);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await chmod(path.dirname(file), 0o700);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({ ...principal, issuedAt: new Date().toISOString() }), { encoding: "utf8", mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, file);
    await chmod(file, 0o600);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function readHostPrincipal(cwd: string): Promise<HostPrincipal> {
  const value = JSON.parse(await readFile(principalPath(cwd), "utf8")) as Partial<HostPrincipal>;
  if (
    typeof value.tenantId !== "string" || !value.tenantId
    || typeof value.userId !== "string" || !value.userId
    || !Array.isArray(value.roles) || value.roles.length < 1
    || value.roles.some((role) => role !== "student" && role !== "teacher")
    || typeof value.issuedAt !== "string"
  ) throw new Error("host principal is invalid");
  return {
    tenantId: value.tenantId,
    userId: value.userId,
    roles: [...new Set(value.roles)].sort() as ("student" | "teacher")[],
    issuedAt: value.issuedAt,
  };
}

export async function clearHostPrincipal(cwd: string): Promise<void> {
  await rm(principalPath(cwd), { force: true });
}
