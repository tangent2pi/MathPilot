/**
 * @agmath/providers-ocr — OCRProvider 实现（设计 §2.4 packages/providers/ocr）。
 *
 * 覆盖 PaddleOCR 官方 API 的 job 模式（AI Studio）；本地 / MCP / 自建服务模式
 * 在阶段 B 以同接口适配器加入。输出保持与队友 TEACHER 管线一致的分页 Markdown
 * + 版面块结构，由 content 服务落库为 SourceFragment。
 *
 * 凭据由调用方（content 服务）从环境注入，本包不持有密钥。
 */
// 注意：使用全局 fetch（Node 内置）而非 undici 包——undici@8.x 的 multipart
// 编码与 aistudio API 不兼容（返回 500）；本包各请求超时均 <300s，无需自定义 dispatcher。

export interface OcrClientConfig {
  readonly baseUrl: string;
  readonly apiToken: string;
  readonly model: string;
  readonly pollIntervalMs?: number;
  readonly pollTimeoutMs?: number;
}

export interface OcrBlockOut {
  readonly block_type: string;
  readonly bbox: number[] | null;
  readonly markdown: string;
  readonly block_order?: number;
}

export interface OcrPageOut {
  readonly page_no: number;
  readonly markdown: string;
  readonly blocks: OcrBlockOut[];
}

export type OcrResult =
  | { readonly ok: true; readonly pages: OcrPageOut[] }
  | { readonly ok: false; readonly kind: "retryable" | "fatal" | "timeout"; readonly code: string; readonly message: string };

function fetchLong(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  return fetch(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const OCR_LABEL_MAP: Record<string, string> = {
  doc_title: "heading",
  paragraph_title: "heading",
  title: "heading",
  table: "table",
  image: "image_region",
  figure: "image_region",
  chart: "image_region",
};

export function createAistudioOcrClient(cfg: OcrClientConfig): {
  parse(
    fileBase64: string,
    filename: string,
    pageRanges: string | undefined,
    pageStart: number,
  ): Promise<OcrResult>;
} {
  const base = cfg.baseUrl.replace(/\/$/, "");
  const pollIntervalMs = cfg.pollIntervalMs ?? 4_000;
  const pollTimeoutMs = cfg.pollTimeoutMs ?? 600_000;

  async function aistudioOcr(
    fileBase64: string,
    filename: string,
    pageRanges: string | undefined,
    pageStart: number,
  ): Promise<OcrResult> {
    const jobsUrl = `${base}/api/v2/ocr/jobs`;
    const bytes = Buffer.from(fileBase64, "base64");

    // 提交（5 次指数退避重试瞬时错误/限流）
    let jobId: string | null = null;
    let lastErr: OcrResult = { ok: false, kind: "retryable", code: "no_attempt", message: "no attempt made" };
    for (let attempt = 0; attempt < 5 && !jobId; attempt++) {
      if (attempt > 0) await sleep(Math.min(1000 * 2 ** (attempt - 1), 15_000));
      try {
        const form = new FormData();
        form.set("model", cfg.model);
        // aistudio API 要求真实 optionalPayload（与队友 TEACHER 管线一致）
        form.set("optionalPayload", JSON.stringify({
          useDocOrientationClassify: false,
          useDocUnwarping: false,
          useChartRecognition: false,
        }));
        if (pageRanges) form.set("pageRanges", pageRanges);
        form.set("file", new Blob([bytes], { type: "application/pdf" }), filename);
        const res = await fetchLong(jobsUrl, {
          method: "POST",
          headers: { authorization: `bearer ${cfg.apiToken}` },
          body: form,
        }, 120_000);
        if (res.status === 429 || res.status >= 500) {
          lastErr = { ok: false, kind: "retryable", code: `http_${res.status}`, message: (await res.text()).slice(0, 300) };
          continue;
        }
        if (!res.ok) return { ok: false, kind: "fatal", code: `http_${res.status}`, message: (await res.text()).slice(0, 300) };
        const data = (await res.json()) as { code?: number; msg?: string; data?: { jobId?: string } };
        if (data.code !== 0 || !data.data?.jobId) {
          return { ok: false, kind: "fatal", code: "submit_rejected", message: JSON.stringify(data).slice(0, 300) };
        }
        jobId = data.data.jobId;
      } catch (err) {
        lastErr = { ok: false, kind: "retryable", code: "network_error", message: err instanceof Error ? err.message : String(err) };
      }
    }
    if (!jobId) return lastErr;

    // 轮询 job 结果
    const deadline = Date.now() + pollTimeoutMs;
    let resultJsonUrl: string | null = null;
    while (Date.now() < deadline) {
      await sleep(pollIntervalMs);
      try {
        const res = await fetchLong(`${jobsUrl}/${jobId}`, {
          headers: { authorization: `Bearer ${cfg.apiToken}` },
        }, 60_000);
        if (!res.ok) continue;
        const data = (await res.json()) as {
          data?: { state?: string; resultUrl?: { jsonUrl?: string }; errorMsg?: string };
        };
        const state = data.data?.state;
        if (state === "done") {
          resultJsonUrl = data.data?.resultUrl?.jsonUrl ?? null;
          break;
        }
        if (state === "failed") {
          return { ok: false, kind: "fatal", code: "ocr_job_failed", message: data.data?.errorMsg ?? "job failed" };
        }
      } catch { /* 瞬时网络错误，继续轮询 */ }
    }
    if (!resultJsonUrl) {
      return { ok: false, kind: "timeout", code: "ocr_poll_timeout", message: `job ${jobId} not done in ${pollTimeoutMs}ms` };
    }

    // 解析 result JSONL → 分页 Markdown + 版面块（块坐标归一化）
    const jsonlRes = await fetchLong(resultJsonUrl, {}, 120_000);
    if (!jsonlRes.ok) return { ok: false, kind: "fatal", code: "result_fetch_failed", message: `http_${jsonlRes.status}` };
    const lines = (await jsonlRes.text()).trim().split("\n").filter((l) => l.trim());

    const pages: OcrPageOut[] = [];
    let pageNo = pageStart;
    for (const line of lines) {
      const parsed = JSON.parse(line) as {
        result?: {
          layoutParsingResults?: {
            markdown?: { text?: string };
            prunedResult?: {
              width?: number; height?: number;
              parsing_res_list?: { block_label?: string; block_content?: string; block_bbox?: number[]; block_order?: number }[];
            };
          }[];
        };
      };
      for (const pr of parsed.result?.layoutParsingResults ?? []) {
        const w = pr.prunedResult?.width ?? 0;
        const h = pr.prunedResult?.height ?? 0;
        const blocks: OcrBlockOut[] = (pr.prunedResult?.parsing_res_list ?? []).map((b) => {
          const raw = b.block_bbox;
          const x1 = raw?.[0] ?? 0;
          const y1 = raw?.[1] ?? 0;
          const x2 = raw?.[2] ?? 0;
          const y2 = raw?.[3] ?? 0;
          const bbox = w > 0 && h > 0
            ? [x1 / w, y1 / h, (x2 - x1) / w, (y2 - y1) / h].map((v) => Math.round(v * 10_000) / 10_000)
            : null;
          const order = b.block_order !== undefined ? Number(b.block_order) : undefined;
          return {
            block_type: OCR_LABEL_MAP[b.block_label ?? ""] ?? "paragraph",
            bbox,
            markdown: b.block_content ?? "",
            ...(order !== undefined ? { block_order: order } : {}),
          };
        });
        pages.push({ page_no: pageNo, markdown: pr.markdown?.text ?? "", blocks });
        pageNo += 1;
      }
    }
    return { ok: true, pages };
  }

  return { parse: aistudioOcr };
}
