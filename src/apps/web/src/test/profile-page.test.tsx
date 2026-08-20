import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "../lib/api";
import { ProfilePage } from "../pages/ProfilePage";

vi.mock("../app/auth", () => ({
  useAuth: () => ({ state: { principal: { user_id: "student-1" } } }),
}));

vi.mock("../lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/api")>();
  return { ...original, apiFetch: vi.fn() };
});

function renderProfile(path = "/profile") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <ProfilePage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("profile learning stage disclosure", () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockImplementation(async (url) => {
      if (url === "/api/my-class") return { classes: [] };
      if (url.endsWith("/profile")) return { grade: "高二", target_score: 140, weekly_hours: "4-6", device_draft: "无草稿" };
      return {};
    });
  });

  it("collapses the entire learning settings form and expands it from the unified settings row", async () => {
    renderProfile();
    const summary = screen.getByText("学习设置", { selector: "strong" }).closest("summary");
    const disclosure = summary?.closest("details");

    expect(summary).not.toBeNull();
    expect(disclosure).not.toHaveAttribute("open");
    expect(await screen.findByText("高二 · 目标 140 分 · 每周 4–6 小时")).toBeInTheDocument();
    expect(screen.getByText("学习阶段").closest("details")).toBe(disclosure);
    expect(screen.getByText("学习目标").closest("details")).toBe(disclosure);
    expect(screen.getByText("学习习惯").closest("details")).toBe(disclosure);

    fireEvent.click(summary!);

    await waitFor(() => expect(disclosure).toHaveAttribute("open"));
    expect(screen.getByLabelText("你现在是哪个年级？")).toHaveValue("高二");
  });
});
