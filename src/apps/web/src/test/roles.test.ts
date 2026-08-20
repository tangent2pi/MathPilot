import { describe, expect, it } from "vitest";
import { hasRole, isTeacher, type Principal } from "../lib/types";

const principal = (roles: string[]): Principal => ({ user_id: "u1", email: "u@example.com", roles });

describe("role routing", () => {
  it("recognizes every teacher workspace role", () => {
    expect(isTeacher(principal(["teacher"]))).toBe(true);
    expect(isTeacher(principal(["content_reviewer"]))).toBe(true);
    expect(isTeacher(principal(["student"]))).toBe(false);
  });

  it("lets tenant administrators pass scoped role gates", () => {
    expect(hasRole(principal(["tenant_admin"]), ["teacher"])).toBe(true);
    expect(hasRole(principal(["student"]), ["teacher"])).toBe(false);
  });
});
