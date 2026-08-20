import { describe, expect, it } from "vitest";
import { postLoginDestination, workspaceHome } from "../lib/auth-routing";
import type { Principal } from "../lib/types";

const principal = (roles: string[]): Principal => ({
  user_id: "usr_test0001",
  tenant_id: "tnt_test0001",
  email: "demo@mathpilot.local",
  roles,
});

describe("role-aware authentication routing", () => {
  it("uses the teacher workspace as the canonical teacher home", () => {
    expect(workspaceHome(principal(["teacher"]))).toBe("/teacher");
    expect(workspaceHome(principal(["content_reviewer"]))).toBe("/teacher");
    expect(workspaceHome(principal(["student"]))).toBe("/");
  });

  it("does not restore a student home or profile for a teacher", () => {
    expect(postLoginDestination(principal(["teacher"]), "/")).toBe("/teacher");
    expect(postLoginDestination(principal(["teacher"]), "/profile?first=1")).toBe("/teacher");
    expect(postLoginDestination(principal(["teacher"]), "/content?status=draft")).toBe("/content?status=draft");
  });

  it("does not restore a teacher route for a student", () => {
    expect(postLoginDestination(principal(["student"]), "/teacher")).toBe("/");
    expect(postLoginDestination(principal(["student"]), "/admin?view=students")).toBe("/");
    expect(postLoginDestination(principal(["student"]), "/solve?run=run_1")).toBe("/solve?run=run_1");
  });

  it("respects narrower teacher permissions", () => {
    expect(postLoginDestination(principal(["content_reviewer"]), "/review?status=pending")).toBe("/review?status=pending");
    expect(postLoginDestination(principal(["content_reviewer"]), "/admin?view=settings")).toBe("/teacher");
    expect(postLoginDestination(principal(["tenant_admin"]), "/admin?view=settings")).toBe("/admin?view=settings");
  });

  it("drops a stale destination after sign-out and rejects external redirects", () => {
    expect(postLoginDestination(principal(["student"]), "/teacher", { signedOut: true })).toBe("/");
    expect(postLoginDestination(principal(["teacher"]), "/", { signedOut: true })).toBe("/teacher");
    expect(postLoginDestination(principal(["teacher"]), "//example.com/admin")).toBe("/teacher");
    expect(postLoginDestination(principal(["student"]), "https://example.com/solve")).toBe("/");
  });
});
