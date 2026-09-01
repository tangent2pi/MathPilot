import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

export interface HostPrincipal {
  tenantId: string;
  userId: string;
  roles: readonly ("student" | "teacher")[];
  issuedAt: string;
}

export const hostStateDirectory = (cwd: string): string => {
  const workspace = path.resolve(cwd);
  return path.join(path.dirname(workspace), ".host-state", path.basename(workspace));
};

export const hostStatePath = (cwd: string, filename: string): string => {
  if (!/^[a-z][a-z0-9-]{0,63}\.json$/.test(filename)) {
    throw new Error("invalid host-state filename");
  }
  return path.join(hostStateDirectory(cwd), filename);
};

export async function writeHostStateJson(cwd: string, filename: string, json: string): Promise<void> {
  const file = hostStatePath(cwd, filename);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await chmod(path.dirname(file), 0o700);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, json, { encoding: "utf8", mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

const principalPath = (cwd: string): string => hostStatePath(cwd, "principal.json");

export async function writeHostPrincipal(cwd: string, principal: Omit<HostPrincipal, "issuedAt">): Promise<void> {
  await writeHostStateJson(
    cwd,
    "principal.json",
    JSON.stringify({ ...principal, issuedAt: new Date().toISOString() }),
  );
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
