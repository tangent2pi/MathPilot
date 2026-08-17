/**
 * AuthProvider：OIDC claims → 领域主体与权限（设计 §16.1）。
 * 认证交给 Keycloak；本接口只做租户映射与领域授权，项目不自制账号/Token。
 */
import type { ProviderRequestBase, ProviderResult } from "../errors.js";

export type DomainRole =
  | "student" | "guardian" | "teacher"
  | "content_reviewer" | "tenant_admin" | "platform_ops";

export interface Principal {
  readonly tenantId: string;
  readonly userId: string;
  readonly roles: readonly DomainRole[];
  /** 学生/教师的数据边界：班级列表等 */
  readonly scope: { readonly classIds?: readonly string[] };
}

export interface AuthenticateRequest extends ProviderRequestBase {
  /** 已验证的 OIDC ID Token claims（由网关完成签名/过期校验） */
  readonly oidcClaims: Record<string, unknown>;
}

export type AuthAction =
  | "session.read" | "session.write"
  | "content.review" | "content.publish"
  | "profile.read" | "correction.write"
  | "audit.read";

export interface AuthProvider {
  authenticate(req: AuthenticateRequest): Promise<ProviderResult<Principal>>;
  /**
   * 领域授权判定；同时必须在 PostgreSQL RLS 落地，
   * 前端隐藏按钮不构成授权（设计 §16.1）。
   */
  authorize(
    principal: Principal,
    action: AuthAction,
    resource: { readonly tenantId: string; readonly ownerStudentId?: string },
  ): Promise<ProviderResult<{ readonly allowed: boolean }>>;
}
