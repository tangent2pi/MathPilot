/**
 * SandboxProvider：单题隔离工作区（设计 §5.2）。
 * 安全边界来自环境（只读挂载、固定写区、禁外网、资源/时长限额），不来自命令白名单。
 */
import type { ProviderRequestBase, ProviderResult } from "../errors.js";

export interface SandboxMount {
  readonly hostRef: string;
  readonly mountPath: string;
  readonly writable: false;
}

export interface SandboxSpec {
  readonly sessionId: string;
  readonly tenantId: string;
  readonly mounts: readonly SandboxMount[];
  /** 可写目录白名单；首版固定 ["/workspace/tmp", "/workspace/output"] */
  readonly writablePaths: readonly string[];
  readonly network: "none";
  readonly quotas: {
    readonly cpuMilli: number;
    readonly memoryMiB: number;
    readonly maxProcesses: number;
    readonly maxOutputBytes: number;
    readonly tmpDiskMiB: number;
  };
}

export interface RunCommandRequest extends ProviderRequestBase {
  readonly sessionId: string;
  readonly argv: readonly string[];
  readonly cwd: string;
}

export interface CommandAudit {
  readonly argv: readonly string[];
  readonly exitCode: number;
  readonly wallClockMs: number;
  readonly outputHash: string;
  readonly resourceUsage: { readonly cpuMs: number; readonly peakMemoryMiB: number };
}

export interface RunCommandResponse {
  readonly exitCode: number;
  readonly stdoutRef: string;
  readonly stderrRef: string;
  readonly audit: CommandAudit;
}

export interface SandboxProvider {
  createSession(spec: SandboxSpec): Promise<ProviderResult<{ readonly handle: string }>>;
  runCommand(req: RunCommandRequest): Promise<ProviderResult<RunCommandResponse>>;
  /** Session 关闭后必须清空 tmp/output 并归档 */
  destroySession(handle: string): Promise<ProviderResult<{ readonly archivedRef?: string }>>;
}
