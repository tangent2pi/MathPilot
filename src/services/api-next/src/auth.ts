import { betterAuth } from "better-auth";
import { fromNodeHeaders } from "better-auth/node";
import type { IncomingHttpHeaders } from "node:http";
import pg from "pg";
import { newId, withTenant } from "./lib.ts";
import { apiNextSecurityConfig, betterAuthRateLimitConfig, BETTER_AUTH_TRUSTED_IP_HEADERS } from "./security-config.ts";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://localhost:5432/mathpilot";
const AUTH_BASE_URL = process.env.BETTER_AUTH_URL ?? "http://localhost:5174";
const SECURITY_CONFIG = apiNextSecurityConfig();
const AUTH_SECRET = SECURITY_CONFIG.betterAuthSecret;
const DEFAULT_TENANT = SECURITY_CONFIG.defaultTenantId;
const trustedOrigins = (process.env.BETTER_AUTH_TRUSTED_ORIGINS ?? AUTH_BASE_URL).split(",").map((value) => value.trim()).filter(Boolean);

export const auth = betterAuth({
  database: new pg.Pool({ connectionString: DATABASE_URL, max: 5 }),
  baseURL: AUTH_BASE_URL,
  secret: AUTH_SECRET,
  trustedOrigins,
  emailAndPassword: { enabled: true, minPasswordLength: 8, maxPasswordLength: 128 },
  rateLimit: betterAuthRateLimitConfig(SECURITY_CONFIG.environment),
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
    ipAddress: { ipAddressHeaders: [...BETTER_AUTH_TRUSTED_IP_HEADERS] },
  },
});

// Only the two product roles are persisted and propagated to next services.
// Retired role labels never reach the next domain and never grant teacher
// access. An account must carry the explicit teacher value; every other or
// missing value receives the normal student default.
const ROLE_ALIASES: Record<string, "student" | "teacher"> = {
  student: "student",
  teacher: "teacher",
};

export interface Principal {
  userId: string;
  uid: string;
  tenantId: string;
  roles: ("student" | "teacher")[];
  authUserId: string;
  name: string;
  email: string;
}

export class AuthError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function rolesFor(value: unknown): string[] {
  const roles = (typeof value === "string" ? value : "student")
    .split(",")
    .map((role) => ROLE_ALIASES[role.trim()])
    .filter((role): role is "student" | "teacher" => Boolean(role));
  const unique = [...new Set(roles)].sort();
  return unique.length ? unique : ["student"];
}

export async function authenticate(pool: pg.Pool, headers: IncomingHttpHeaders): Promise<Principal> {
  const session = await auth.api.getSession({ headers: fromNodeHeaders(headers) });
  if (!session) throw new AuthError(401, "authentication required");
  const authUser = session.user as typeof session.user & { role?: string };
  const account = (await pool.query<{ uid: string }>(`select uid::text from "user" where id=$1`, [authUser.id])).rows[0];
  if (!account?.uid) throw new AuthError(401, "account UID is unavailable");
  const requestedRoles = rolesFor(authUser.role);
  const domain = await withTenant(pool, DEFAULT_TENANT, async (client) => (await client.query<{ user_id: string; tenant_id: string }>(
    `insert into identity_user (user_id, tenant_id, oidc_sub, display_name, roles)
     values ($1,$2,$3,$4,$5)
     on conflict (oidc_sub) do update set display_name=excluded.display_name
     returning user_id,tenant_id`,
    [newId("usr"), DEFAULT_TENANT, authUser.id, authUser.name || authUser.email, requestedRoles],
  )).rows[0]);
  if (!domain) throw new AuthError(401, "account domain mapping is unavailable");
  // The normalized role relation is the next domain fact source.  The auth
  // provider's single string is only an input hint and is never propagated as
  // an arbitrary role list.
  const roles = await withTenant(pool, domain.tenant_id, async (client) => {
    // The relation is the domain fact source.  A provider role is used only
    // when this Better Auth account is first mapped; later requests cannot
    // silently erase a teacher/student assignment made by the domain.
    const existing = await client.query<{ role: "student" | "teacher" }>(
      `select role from identity_user_role where tenant_id=$1 and user_id=$2 order by role`,
      [domain.tenant_id, domain.user_id],
    );
    if (!existing.rows.length) {
      await client.query(
        `insert into identity_user_role(tenant_id,user_id,role,assigned_by_user_id)
         select $1,$2,unnest($3::text[]),null
         on conflict (user_id,role) do nothing`,
        [domain.tenant_id, domain.user_id, requestedRoles],
      );
    }
    const result = await client.query<{ role: "student" | "teacher" }>(
      `select role from identity_user_role where tenant_id=$1 and user_id=$2 order by role`,
      [domain.tenant_id, domain.user_id],
    );
    return result.rows.map((row) => row.role);
  });
  const normalizedRoles: ("student" | "teacher")[] = roles.length ? roles : ["student"];
  return {
    userId: domain.user_id, uid: account.uid, tenantId: domain.tenant_id, roles: normalizedRoles,
    authUserId: authUser.id, name: authUser.name || authUser.email, email: authUser.email,
  };
}

export function requireRole(principal: Principal, role: "student" | "teacher"): void {
  if (!principal.roles.includes(role)) throw new AuthError(403, `requires role: ${role}`);
}

export async function bootstrapAuthUsers(): Promise<void> {
  const users = [
    { email: process.env.BETTER_AUTH_STUDENT_EMAIL, password: process.env.BETTER_AUTH_STUDENT_PASSWORD, name: "Demo Student", role: "student" },
    { email: process.env.BETTER_AUTH_TEACHER_EMAIL, password: process.env.BETTER_AUTH_TEACHER_PASSWORD, name: "Demo Teacher", role: "teacher" },
  ].filter((user): user is { email: string; password: string; name: string; role: string } => Boolean(user.email && user.password));
  if (!users.length) return;
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
  try {
    for (const user of users) {
      const existing = await pool.query<{ id: string }>(`select id from "user" where email=$1`, [user.email]);
      const userId = existing.rows[0]?.id ?? (await auth.api.signUpEmail({ body: { email: user.email, password: user.password, name: user.name } })).user.id;
      await pool.query(`update "user" set role=$2 where id=$1`, [userId, user.role]);
      const fixtureId = user.role.startsWith("teacher") ? "usr_teacher01" : "usr_student01";
      await withTenant(pool, DEFAULT_TENANT, async (client) => {
        await client.query(`update identity_user set oidc_sub=$1,display_name=$2,roles=$3 where user_id=$4`, [userId, user.name, user.role.split(","), fixtureId]);
        await client.query(
          `insert into identity_user_role(tenant_id,user_id,role,assigned_by_user_id)
           values($1,$2,$3,null) on conflict (user_id,role) do nothing`,
          [DEFAULT_TENANT, fixtureId, user.role === "teacher" ? "teacher" : "student"],
        );
      });
    }
  } finally { await pool.end(); }
}
