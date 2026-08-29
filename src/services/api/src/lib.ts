/**
 * 服务自身引导件（设计 §2.4：模块自包含，不共享私有包；各服务内联自身引导）。
 */
import Fastify, { type FastifyInstance } from "fastify";
import pg from "pg";
import { Agent, fetch as undiciFetch } from "undici";

export interface ServiceOptions {
  name: string;
  port: number;
  register?: (app: FastifyInstance) => void | Promise<void>;
}

export async function startService(opts: ServiceOptions): Promise<FastifyInstance> {
  // 最大 32MiB 的 base64 字段还有 JSON 封装开销，入口需留出余量。
  const app = Fastify({ logger: true, bodyLimit: 48 * 1024 * 1024 });

  app.get("/healthz", async () => ({ status: "ok", service: opts.name }));
  app.get("/readyz", async () => ({ status: "ready", service: opts.name }));

  if (opts.register) await opts.register(app);

  await app.listen({ port: opts.port, host: "0.0.0.0" });
  return app;
}

export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString, max: 5 });
}

/**
 * 在事务内激活 RLS 租户上下文后执行 fn。
 * 连接必须使用最小权限账号（mathpilot_app），RLS 才对非 owner 生效（设计 §16.1）。
 */
export async function withTenant<T>(
  pool: pg.Pool,
  tenantId: string,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('app.current_tenant', $1, true)", [tenantId]);
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

/**
 * 长任务 fetch：undici 默认 headersTimeout=300s 会先于业务超时断开下游长任务
 * （模型判答/OCR/抽取可达 5–10 分钟）。统一 dispatcher 提高 headers/body 超时，
 * 并叠加 AbortSignal.timeout 作为业务上限。
 */
const longAgent = new Agent({ headersTimeout: 600_000, bodyTimeout: 600_000, connectTimeout: 30_000 });

export function longFetch(url: string | URL, init: RequestInit = {}, timeoutMs = 600_000): Promise<Response> {
  return undiciFetch(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
    dispatcher: longAgent,
  } as Parameters<typeof undiciFetch>[1]);
}
