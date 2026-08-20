import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "../lib/api";
import { ContentPage } from "../pages/ContentPage";

vi.mock("../app/auth", () => ({
  useAuth: () => ({ state: { principal: { user_id: "teacher-1", roles: [] } } }),
}));

vi.mock("../lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/api")>();
  return { ...original, apiFetch: vi.fn() };
});

const failedRun = {
  run_id: "pipe-retry-1",
  chapter_id: "chapter-1",
  status: "failed",
  stage: "ktq",
  document_ids: ["doc-1"],
  ktq_session_ref: "run_ktq_old",
  er_session_ref: "run_er_old",
  error_detail: "KTQ 502: upstream error",
  created_at: "2026-08-20T10:00:00.000Z",
  library_visibility: "teacher",
  payload: { files: [{ document_id: "doc-1", name: "讲义.pdf" }] },
};

let runs: unknown[] = [];

function renderContent() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/content"]}>
        <ContentPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("content pipeline card actions", () => {
  beforeEach(() => {
    runs = [];
    vi.mocked(apiFetch).mockImplementation(async (url, init) => {
      if (String(url).endsWith("/retry")) {
        runs = [{ ...failedRun, can_retry: true, status: "queued", stage: "ktq", ktq_session_ref: "run_ktq_new", er_session_ref: "run_er_new", error_detail: null }];
        return { run_id: "pipe-retry-1", status: "queued", stage: "ktq", ktq_session_ref: "run_ktq_new", er_session_ref: "run_er_new", error_detail: null };
      }
      if (String(url).endsWith("/dismiss")) {
        runs = [];
        return { run_id: "pipe-retry-1", dismissed: true };
      }
      if (String(url).endsWith("/api/content/pipelines") && (!init || init.method === "GET")) {
        return { runs };
      }
      return {};
    });
  });

  it("对失败任务点击重试会重启流水线并清除错误提示", async () => {
    runs = [{ ...failedRun, can_retry: true }];
    renderContent();

    expect(await screen.findByText(/需要处理/)).toBeInTheDocument();
    expect(screen.getByText(/处理遇到问题/)).toBeInTheDocument();
    const retryButton = screen.getByRole("button", { name: "重试处理" });
    expect(retryButton).toBeEnabled();

    fireEvent.click(retryButton);

    await waitFor(() => expect(vi.mocked(apiFetch)).toHaveBeenCalledWith("/api/content/pipelines/pipe-retry-1/retry", { method: "POST" }));
    expect(await screen.findByText(/任务已重新启动/)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText(/处理遇到问题/)).not.toBeInTheDocument());
  });

  it("失败但 can_retry=false 的任务只提供关闭，不提供重试", async () => {
    runs = [{ ...failedRun, can_retry: false }];
    renderContent();

    expect(await screen.findByText(/需要处理/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "重试处理" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "关闭卡片" })).toBeInTheDocument();
  });

  it("点击关闭卡片会从最近任务中移除该卡片", async () => {
    runs = [{ ...failedRun, can_retry: true }];
    renderContent();

    expect(await screen.findByText(/需要处理/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "关闭卡片" }));

    await waitFor(() => expect(vi.mocked(apiFetch)).toHaveBeenCalledWith("/api/content/pipelines/pipe-retry-1/dismiss", { method: "POST" }));
    await waitFor(() => expect(screen.queryByText(/需要处理/)).not.toBeInTheDocument());
    expect(await screen.findByText(/还没有内容任务/)).toBeInTheDocument();
  });
});
