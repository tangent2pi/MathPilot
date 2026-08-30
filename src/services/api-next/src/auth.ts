import { betterAuth } from "better-auth";
import { fromNodeHeaders } from "better-auth/node";
import type { IncomingHttpHeaders } from "node:http";
import pg from "pg";
import { newId, withTenant } from "./lib.ts";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://localhost:5432/mathpilot";
const AUTH_BASE_URL = process.env.BETTER_AUTH_URL ?? "http://localhost:5174";
const AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "mathpilot-dev-secret-change-me-at-least-32-characters";
const DEV_TENANT = process.env.DEV_TENANT_ID ?? "tnt_dev00001";
const trustedOrigins = (process.env.BETTER_AUTH_TRUSTED_ORIGINS ?? AUTH_BASE_URL).split(",").map((value) => value.trim()).filter(Boolean);
const ipAddressHeaders = (process.env.BETTER_AUTH_IP_ADDRESS_HEADERS ?? "x-real-ip").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);

export const auth = betterAuth({
  database: new pg.Pool({ connectionString: DATABASE_URL, max: 5 }),
  baseURL: AUTH_BASE_URL,
  secret: AUTH_SECRET,
  trustedOrigins,
  emailAndPassword: { enabled: true, minPasswordLength: 8, maxPasswordLength: 128 },
  user: {
    changeEmail: { enabled: true, updateEmailWithoutVerification: true },
    additionalFields: {
      role: { type: "string", required: false, defaultValue: "student", input: false },
      phone: {
        type: "string", required: false, input: true,
        transform: { input: (value) => typeof value === "string" ? value.trim().replace(/[\s()-]/g, "").slice(0, 24) : value },
      },
    },
  },
  session: { expiresIn: 60 * 60 * 24 * 7, updateAge: 60 * 60 * 24, cookieCache: { enabled: true, maxAge: 5 * 60 } },
  advanced: {
    cookiePrefix: "mathpilot",
    useSecureCookies: (process.env.BETTER_AUTH_SECURE_COOKIES ?? (process.env.NODE_ENV === "production" ? "true" : "false")) === "true",
    ipAddress: { ipAddressHeaders },
  },
});

const DOMAIN_ROLES = new Set(["student", "guardian", "teacher", "content_reviewer", "tenant_admin", "platform_ops"]);

export interface Principal {
  userId: string;
  uid: string;
  tenantId: string;
  roles: string[];
  authUserId: string;
  name: string;
  email: string;
}

export class AuthError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function rolesFor(value: unknown): string[] {
  const roles = (typeof value === "string" ? value : "student").split(",").map((role) => role.trim()).filter((role) => DOMAIN_ROLES.has(role));
  return roles.length ? roles : ["student"];
}

export async function authenticate(pool: pg.Pool, headers: IncomingHttpHeaders): Promise<Principal> {
  const session = await auth.api.getSession({ headers: fromNodeHeaders(headers) });
  if (!session) throw new AuthError(401, "authentication required");
  const authUser = session.user as typeof session.user & { role?: string };
  const account = (await pool.query<{ uid: string }>(`select uid::text from "user" where id=$1`, [authUser.id])).rows[0];
  if (!account?.uid) throw new AuthError(401, "account UID is unavailable");
  const roles = rolesFor(authUser.role);
  const domain = await withTenant(pool, DEV_TENANT, async (client) => (await client.query<{ user_id: string; tenant_id: string }>(
    `insert into identity_user (user_id, tenant_id, oidc_sub, display_name, roles)
     values ($1,$2,$3,$4,$5)
     on conflict (oidc_sub) do update set display_name=excluded.display_name,roles=excluded.roles
     returning user_id,tenant_id`,
    [newId("usr"), DEV_TENANT, authUser.id, authUser.name || authUser.email, roles],
  )).rows[0]);
  if (!domain) throw new AuthError(401, "account domain mapping is unavailable");
  return {
    userId: domain.user_id, uid: account.uid, tenantId: domain.tenant_id, roles,
    authUserId: authUser.id, name: authUser.name || authUser.email, email: authUser.email,
  };
}

export function requireRole(principal: Principal, role: string): void {
  if (!principal.roles.includes(role) && !principal.roles.includes("tenant_admin")) throw new AuthError(403, `requires role: ${role}`);
}

export async function bootstrapAuthUsers(): Promise<void> {
  const users = [
    { email: process.env.BETTER_AUTH_STUDENT_EMAIL, password: process.env.BETTER_AUTH_STUDENT_PASSWORD, name: "Demo Student", role: "student" },
    { email: process.env.BETTER_AUTH_TEACHER_EMAIL, password: process.env.BETTER_AUTH_TEACHER_PASSWORD, name: "Demo Teacher", role: "teacher,content_reviewer" },
  ].filter((user): user is { email: string; password: string; name: string; role: string } => Boolean(user.email && user.password));
  if (!users.length) return;
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
  try {
    for (const user of users) {
      const existing = await pool.query<{ id: string }>(`select id from "user" where email=$1`, [user.email]);
      const userId = existing.rows[0]?.id ?? (await auth.api.signUpEmail({ body: { email: user.email, password: user.password, name: user.name } })).user.id;
      await pool.query(`update "user" set role=$2 where id=$1`, [userId, user.role]);
      const fixtureId = user.role.startsWith("teacher") ? "usr_teacher01" : "usr_student01";
      await withTenant(pool, DEV_TENANT, async (client) => {
        await client.query(`update identity_user set oidc_sub=$1,display_name=$2,roles=$3 where user_id=$4`, [userId, user.name, user.role.split(","), fixtureId]);
      });
    }
  } finally { await pool.end(); }
}
