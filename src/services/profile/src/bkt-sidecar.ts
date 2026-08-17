/**
 * pyBKT 侧车客户端（ADR-001 / 科学内核与Dream设计v1 §1.2）。
 *
 * 经 stdin JSON-lines → stdout JSON 调用 sidecars/pybkt/cli.py。
 * 侧车状态 = 观测日志重放（无隐藏状态），PYBKT_STATE_DIR 决定持久位置。
 * 侧车失败显式返回错误，调用方不得静默回退（Review-001"严禁回退方案"）。
 */
import { spawn } from "node:child_process";

// 默认使用侧车 venv 解释器（sidecars/pybkt/setup.sh 创建）；部署时经 env 注入
const SIDECAR_PYTHON = process.env.PYBKT_PYTHON ?? "/home/tangent/AGMATH/sidecars/pybkt/.venv/bin/python";
const SIDECAR_CLI = process.env.PYBKT_CLI ?? "/home/tangent/AGMATH/sidecars/pybkt/cli.py";
const PYBKT_STATE_DIR = process.env.PYBKT_STATE_DIR ?? "/home/tangent/AGMATH/sidecars/pybkt/state";

export type SidecarResult<T> = { ok: true; value: T } | { ok: false; error: string; detail?: string };

/** 单次侧车调用：spawn → 发一行请求 → 读末行响应 */
export async function sidecarCall<T>(req: Record<string, unknown>): Promise<SidecarResult<T>> {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(SIDECAR_PYTHON, [SIDECAR_CLI], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, PYBKT_STATE_DIR },
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      resolve({ ok: false, error: "sidecar_spawn_failed", ...(detail ? { detail } : {}) });
      return;
    }
    let out = "";
    let errOut = "";
    const timeout = setTimeout(() => {
      proc.kill();
      resolve({ ok: false, error: "sidecar_timeout", detail: "侧车 60s 无响应" });
    }, 60_000);
    proc.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => { errOut += d.toString(); });
    proc.on("error", (err) => {
      clearTimeout(timeout);
      resolve({ ok: false, error: "sidecar_spawn_failed", detail: err.message });
    });
    proc.on("close", () => {
      clearTimeout(timeout);
      const lines = out.trim().split("\n").filter(Boolean);
      if (lines.length === 0) {
        const detail = errOut.slice(0, 300);
        resolve({ ok: false, error: "sidecar_no_output", ...(detail ? { detail } : {}) });
        return;
      }
      try {
        const d = JSON.parse(lines[lines.length - 1]!) as { ok?: boolean; value?: T; error?: string; detail?: string };
        if (d.ok) resolve({ ok: true, value: d.value as T });
        else resolve({ ok: false, error: d.error ?? "sidecar_error", ...(d.detail !== undefined ? { detail: d.detail } : {}) });
      } catch {
        resolve({ ok: false, error: "sidecar_invalid_output", detail: out.slice(0, 300) });
      }
    });
    proc.stdin.write(JSON.stringify(req) + "\n");
    proc.stdin.end();
  });
}

/** 逐学生×逐维度掌握度（Dream 程序基准，§4） */
export async function rosterGetMastery(studentId: string, dimensionId: string): Promise<SidecarResult<{ p_mastery: number | null }>> {
  return sidecarCall<{ p_mastery: number | null }>({
    op: "roster_get",
    student_id: studentId,
    dimension_id: dimensionId,
  });
}

/** 追加观测（幂等：order_id 唯一） */
export async function rosterUpdate(
  studentId: string,
  dimensionId: string,
  outcome: "success" | "failure",
  orderId: string,
): Promise<SidecarResult<{ p_mastery: number | null }>> {
  return sidecarCall<{ p_mastery: number | null }>({
    op: "roster_update",
    student_id: studentId,
    dimension_id: dimensionId,
    outcome,
    order_id: orderId,
  });
}
