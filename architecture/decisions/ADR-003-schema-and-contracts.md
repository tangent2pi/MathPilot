# ADR-003：契约与 Schema 治理

- 状态：已接受
- 日期：2026-08-17
- 依据：`进一步实施规划v1` §3、§11

## 背景

系统由多模块并行实现，任何跨模块对象都需要稳定的版本化契约；字段血缘与审计要求每个正式语义字段可追溯。

## 决策

1. **JSON Schema (draft 2020-12) 是唯一契约源**：
   - 目录 `packages/contracts/schemas/<group>/<name>.schema.json`；
   - `$id` 必须是合法 URI，形如 `https://schemas.agmath.dev/<group>/<name>/v<major>`（跨 schema `$ref` 依赖 URI 解析；裸标识符无法被 referencing/Ajv 解析）；
   - 校验使用本 schema 文件（禁止复制式漂移）；
   - 每个 schema 必须配 `*.examples.json`：`valid`、`missing_field`、`invalid_source` 三类样例；
   - 每个 schema 的 `$description` 内注明生产者与消费者，written-by 与 read-by 清单不得只存在于 ADR。
2. OpenAPI 与 TS 类型均为契约的派生品（由 `ui-sdk` 生成），不允许手写生成物。
3. 版本兼容规则：
   - 对象语义变更必须升 `$id` 主版本，禁止静默修改既有字段含义；
   - 新增可选字段为小版本向后兼容；
   - 改变 required/权限语义视为破坏性变更，必须新增 ADR。
4. 一切正式语义字段的 producer 必须同时写 `provenance`（见 `common/provenance.schema.json`）。

## 后果

- 并行开发以契约文件为唯一协商点；
- 契约测试自动生成：合法样例必须通过，缺字段/越权样例必须失败；
- 变更流程重：正确，符合"任何一级决策变化都要增加 ADR + 迁移影响"的要求。