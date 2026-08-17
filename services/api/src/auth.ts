/**
 * api 网关 AuthProvider 适配（WP-03，设计 §16.1）：
 * 认证归 Keycloak（OIDC），本模块只做验签、JIT 领域用户映射与租户/角色注入。
 *
 * 两条路径：
 * - 有 Authorization: Bearer —— 严格验签（issuer + JWKS 签名 + exp），失败即 401；
 *   验签通过后按 oidc_sub JIT upsert identity_user，principal 的 tenant/user/roles
 *   全部来自服务端，客户端 x-tenant-id 一律忽略。
 * - 无 Authorization 且 AUTH_DEV_FALLBACK=true —— dev 直通（信任请求体，保持
 *   流程验证可用）；生产必须置 false，届时无 token 即 401。
 */
import { createRemoteJWKSet, jwtVerify } from "jose";
import type pg from "pg";
import { withTenant, newId } from "@agmath/service-kit";

const OIDC_ISSUER = process.env.OIDC_ISSUER ?? "http://localhost:8080/realms/agmath";
const OIDC_JWKS_URL = process.env.OIDC_JWKS_URL ?? `${OIDC_ISSUER}/protocol/openid-connect/certs`;
const AUTH_DEV_FALLBACK = (process.env.AUTH_DEV_FALLBACK ?? "true") === "true";
const DEV_TENANT = process.env.DEV_TENANT_ID ?? "tnt_dev00001";

const DOMAIN_ROLES = new Set([
  "student", "guardian", "teacher", "content_reviewer", "tenant_admin", "platform_ops",
]);

export interface Principal {
  userId: string;
  tenantId: string;
  roles: string[];
  via: "oidc" | "dev_fallback";
}

export class AuthError extends Error {
  // 不用 TS 参数属性（Node type stripping 仅支持可擦除语法）
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

interface KeycloakClaims {
  sub?: string;
  preferred_username?: string;
  realm_access?: { roles?: string[] };
}

export async function authenticate(pool: pg.Pool, authorization: string | undefined): Promise<Principal> {
  if (!authorization) {
    if (AUTH_DEV_FALLBACK) {
      return { userId: "usr_student01", tenantId: DEV_TENANT, roles: ["student", "teacher"], via: "dev_fallback" };
    }
    throw new AuthError(401, "missing bearer token");
  }
  const token = authorization.replace(/^Bearer\s+/i, "");
  jwks ??= createRemoteJWKSet(new URL(OIDC_JWKS_URL));

  let claims: KeycloakClaims;
  try {
    const { payload } = await jwtVerify(token, jwks, { issuer: OIDC_ISSUER });
    claims = payload as KeycloakClaims;
  } catch {
    throw new AuthError(401, "invalid or expired token");
  }
  if (!claims.sub) throw new AuthError(401, "token missing sub");

  const roles = (claims.realm_access?.roles ?? []).filter((r) => DOMAIN_ROLES.has(r));
  if (roles.length === 0) throw new AuthError(403, "no domain role granted");

  // JIT 映射：oidc_sub → identity_user；租户映射生产版来自组织 claim，骨架统一入 dev 租户
  const candidateUserId = newId("usr");
  const user = await withTenant(pool, DEV_TENANT, async (c) => {
    const r = await c.query(
      `insert into identity_user (user_id, tenant_id, oidc_sub, display_name, roles)
       values ($1, $2, $3, $4, $5)
       on conflict (oidc_sub)
       do update set display_name = excluded.display_name, roles = excluded.roles
       returning user_id, tenant_id`,
      [candidateUserId, DEV_TENANT, claims.sub, claims.preferred_username ?? claims.sub, roles],
    );
    return r.rows[0] as { user_id: string; tenant_id: string };
  });

  return { userId: user.user_id, tenantId: user.tenant_id, roles, via: "oidc" };
}

export function requireRole(principal: Principal, role: string): void {
  // dev 直通不做角色门（流程验证）；OIDC 路径严格执行
  if (principal.via === "oidc" && !principal.roles.includes(role)) {
    throw new AuthError(403, `requires role: ${role}`);
  }
}
