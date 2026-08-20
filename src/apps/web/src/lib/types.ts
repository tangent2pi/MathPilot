export type Principal = {
  user_id: string;
  email: string;
  tenant_id?: string;
  roles: string[];
  display_name?: string;
};

export type SessionUser = {
  id: string;
  email: string;
  name?: string | null;
  image?: string | null;
  phone?: string | null;
};

export type AuthState = {
  principal: Principal;
  user: SessionUser;
};

const TEACHER_ROLES = ["teacher", "content_reviewer", "tenant_admin"] as const;

export function isTeacher(principal: Principal | null | undefined): boolean {
  return Boolean(principal?.roles.some((role) => TEACHER_ROLES.includes(role as typeof TEACHER_ROLES[number])));
}

export function hasRole(principal: Principal, roles: string[]): boolean {
  return principal.roles.includes("tenant_admin") || roles.some((role) => principal.roles.includes(role));
}
