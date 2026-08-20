/**
 * Better Auth 认证适配：认证、密码哈希、Session Cookie、CSRF/Origin 校验均由
 * Better Auth 承担；本模块只把已认证 user 映射为 MathPilot 的租户领域主体。
 */
import { betterAuth } from "better-auth";
import { fromNodeHeaders } from "better-auth/node";
import pg from "pg";
import type { IncomingHttpHeaders } from "node:http";
import { withTenant, newId } from "./lib.ts";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://localhost:5432/agmath";
const AUTH_BASE_URL = process.env.BETTER_AUTH_URL ?? "http://localhost:8080";
const AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "agmath-dev-secret-change-me-at-least-32-characters";
const DEV_TENANT = process.env.DEV_TENANT_ID ?? "tnt_dev00001";
const trustedOrigins = (process.env.BETTER_AUTH_TRUSTED_ORIGINS ?? AUTH_BASE_URL)
  .split(",").map((s) => s.trim()).filter(Boolean);
const ipAddressHeaders = (process.env.BETTER_AUTH_IP_ADDRESS_HEADERS ?? "x-real-ip")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

export const auth = betterAuth({
  database: new pg.Pool({ connectionString: DATABASE_URL, max: 5 }),
  baseURL: AUTH_BASE_URL,
  secret: AUTH_SECRET,
  trustedOrigins,
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
    maxPasswordLength: 128,
  },
  user: {
    changeEmail: {
      enabled: true,
      // 新注册账号在配置邮件服务前尚未验证邮箱；允许这类账号自行修正地址。
      // 已验证账号仍由 Better Auth 强制进入验证流程。
      updateEmailWithoutVerification: true,
    },
    additionalFields: {
      role: {
        type: "string",
        required: false,
        defaultValue: "student",
        input: false,
      },
      phone: {
        type: "string",
        required: false,
        input: true,
        transform: {
          input: (value) => typeof value === "string" ? value.trim().replace(/[\s()-]/g, "").slice(0, 24) : value,
        },
      },
    },
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7,
    updateAge: 60 * 60 * 24,
    cookieCache: { enabled: true, maxAge: 5 * 60 },
  },
  advanced: {
    cookiePrefix: "agmath",
    useSecureCookies: (process.env.BETTER_AUTH_SECURE_COOKIES ?? (process.env.NODE_ENV === "production" ? "true" : "false")) === "true",
    // 只读取由同源反向代理覆盖写入的地址头。生产部署不得把 API 端口直接暴露给终端用户。
    ipAddress: { ipAddressHeaders },
  },
});

const DOMAIN_ROLES = new Set(["student", "guardian", "teacher", "content_reviewer", "tenant_admin", "platform_ops"]);

export interface Principal {
  userId: string;
  tenantId: string;
  roles: string[];
  via: "better_auth";
  authUserId: string;
  email: string;
}

export class AuthError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function rolesFor(value: unknown): string[] {
  const role = typeof value === "string" ? value : "student";
  const roles = role.split(",").map((r) => r.trim()).filter((r) => DOMAIN_ROLES.has(r));
  return roles.length ? roles : ["student"];
}

export async function authenticate(pool: pg.Pool, headers: IncomingHttpHeaders): Promise<Principal> {
  const session = await auth.api.getSession({ headers: fromNodeHeaders(headers) });
  if (!session) throw new AuthError(401, "authentication required");
  const authUser = session.user as typeof session.user & { role?: string };
  const roles = rolesFor(authUser.role);

  const candidateUserId = newId("usr");
  const domain = await withTenant(pool, DEV_TENANT, async (c) => {
    const r = await c.query(
      `insert into identity_user (user_id, tenant_id, oidc_sub, display_name, roles)
       values ($1,$2,$3,$4,$5)
       on conflict (oidc_sub)
       do update set display_name = excluded.display_name, roles = excluded.roles
       returning user_id, tenant_id`,
      [candidateUserId, DEV_TENANT, authUser.id, authUser.name || authUser.email, roles],
    );
    return r.rows[0] as { user_id: string; tenant_id: string };
  });

  return {
    userId: domain.user_id,
    tenantId: domain.tenant_id,
    roles,
    via: "better_auth",
    authUserId: authUser.id,
    email: authUser.email,
  };
}

export function requireRole(principal: Principal, role: string): void {
  if (!principal.roles.includes(role) && !principal.roles.includes("tenant_admin")) {
    throw new AuthError(403, `requires role: ${role}`);
  }
}

/** 可选开发引导账号仍通过 Better Auth 的服务端 API 创建，不写入密码哈希。 */
export async function bootstrapAuthUsers(): Promise<void> {
  const users = [
    { email: process.env.BETTER_AUTH_STUDENT_EMAIL, password: process.env.BETTER_AUTH_STUDENT_PASSWORD, name: "Demo Student", role: "student" },
    { email: process.env.BETTER_AUTH_TEACHER_EMAIL, password: process.env.BETTER_AUTH_TEACHER_PASSWORD, name: "Demo Teacher", role: "teacher,content_reviewer" },
  ].filter((u): u is { email: string; password: string; name: string; role: string } => Boolean(u.email && u.password));
  if (!users.length) return;
  const adminPool = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
  try {
    for (const u of users) {
      const existing = await adminPool.query(`select id from "user" where email = $1`, [u.email]);
      let userId = existing.rows[0]?.id as string | undefined;
      if (!userId) {
        const created = await auth.api.signUpEmail({ body: { email: u.email, password: u.password, name: u.name } });
        userId = created.user.id;
      }
      await adminPool.query(`update "user" set role = $2 where id = $1`, [userId, u.role]);
      const fixtureUserId = u.role.startsWith("teacher") ? "usr_teacher01" : "usr_student01";
      await withTenant(adminPool, DEV_TENANT, async (c) => {
        await c.query(
          `update identity_user set oidc_sub=$1, display_name=$2, roles=$3 where user_id=$4`,
          [userId, u.name, u.role.split(","), fixtureUserId],
        );
      });
    }
  } finally {
    await adminPool.end();
  }
}
