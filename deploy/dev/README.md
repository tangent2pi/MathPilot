# deploy/dev — 全模块组合根（实施规划 §4）

一条命令启动本地组合环境：

```sh
cd deploy/dev
cp .env.example .env        # 按需修改
docker compose up -d
```

## 当前覆盖

- **postgresql**：唯一事实源（`db-migrate` 幂等迁移 job + `db-seed` dev 种子；RLS + 不可变事件 trigger + 列级处理元数据守卫）
- **minio**：对象存储（原始文档、笔迹流、Artifact、Session 归档）
- **keycloak**：OIDC 认证（realm 见 `keycloak/realm-agmath.json`；healthcheck 探测 realm well-known）
- **otel-collector**：trace 贯通 API/Session/Provider/Decision
- **全部 10 服务已启用**：api（OIDC 验签 + JIT 用户映射 + 角色门）、learning（教学闭环）、profile（Dream 消费 + Validator + 快照）、review（纠正 supersede + 重放 + 修订 SLR 入队）、content（文档→KTQ/ER→复核门→发布 + 字段血缘）、provider-broker（fake Provider 同构 trace）、artifact / agent-runtime / sandbox-runner（骨架）、web-test（nginx 同源反代）

## 鉴权（WP-03）

- 带 `Authorization: Bearer` 的请求严格验签（issuer + JWKS + exp），principal 的
  tenant/user/roles 来自服务端；学生角色强制自域，教师端点要求 teacher 角色。
- 无 token 且 `AUTH_DEV_FALLBACK=true`（默认）时走 dev 直通，保持流程验证可用；
  **生产必须置 `AUTH_DEV_FALLBACK=false`（无 token 即 401）并移除 realm 中的
  `agmath-dev-cli` 客户端（password grant 仅供 dev smoke 取 token）**。
- dev 账号：`teacher.dev` / `student.dev`，密码 `dev-only`。

## 验证

```sh
bash ../../tests/e2e/smoke.sh
# 覆盖：健康检查 → 教学闭环（判答/SER/TSS/SLR）→ Dream/Validator/快照 →
# 教师纠正 supersede + 修订 SLR → Dream supersede 链 → OIDC（自域强制/401/403）→
# 内容管线（文档→KTQ→ER→复核门→发布→字段血缘追溯）
```

## 约定

单一组合根：**禁止**复制出 demo/competition 第二套组合根。fake Provider 必须产生与正式实现同构的 ProviderTrace 字段（implementation 以 `fake.` 前缀标识）。
