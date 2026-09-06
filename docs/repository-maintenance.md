# 仓库整理与 home 核对（2026-09-06）

## Git 基线与同步

清理前工作区的源码和新增测试已提交为 `09f5c3c`，推送到 `origin/next-teammate`。
home 部署根为 `/srv/stacks/mathpilot-next`，Git HEAD 为 `aa202d6`。逐文件 SHA-256
比较显示，服务器工作区应用改动与上述基线一致；唯一不同的同名测试是本地额外增加的
教师复核卡时序用例，本地还有若干未部署测试。

服务器独有的当前 `/defense/` 演示已恢复到 `src/apps/web-next/public/defense/`，
包含入口、翻页运行时、样式、知识库展示数据、PDF、缩略图和视频。删除了完全重复的
HTML 入口和未引用的图表/代码高亮库及额外主题；原入口由 Nginx 重定向到 `/defense/`。
历史 `defense-backup-*` 不作为正式源码导入。

运行容器也作了单独检查：Pi 容器的 `extensions/sandbox.ts` 是不接受显式 cwd 的旧版本，
已下载到本地参考档案；当前源码有较新实现，未被旧镜像覆盖。下次部署应重建对应镜像。
本次未更新线上源码、重启容器或修改数据库/对象卷。

## 清理内容

- `deploy/dev` 从 100 个跟踪文件收敛为 5 个组合配置/初始化文件。删除固定浏览器会话、
  固定数据 ID、Windows 绝对路径的临时探针和修补脚本，以及退役接口回归与旧表 fixture。
- Pi 数据库 runner 和 5 份迁移由前端目录移至 `db/pi`；同步 Compose、文档与根脚本。
  主库 runner 改为从脚本位置解析迁移目录，并支持显式目录参数，消除只能在容器根运行的路径。
- 保留有用的 XLSX 转换器到 `db/tools`，配置仓库相对默认路径和命令参数；Nix 补齐 openpyxl。
- 删除无人依赖的旧 `mastery`、`selector`、`providers/model` workspace 和旧任务 `policies`。
  当前科学算法在 `learning-next`，任务策略在任务注册表与各服务 Skills。
- 删除无调用方的自动批准空实现/查询、只验证空实现的测试、三个 API 转发壳，
  以及未挂载的测评弹窗、其客户端写方法和未使用的 UI 组件。
- 前端已有 12 个测试接入 `pnpm test`；补齐 tsx 和跨 workspace 源码类型检查需要的
  `@types/cross-spawn`，同步锁文件，移除已退役 workspace 的锁文件条目。
- 修正 TaskSpec 白名单的旧断言及五项前台能力与 `maxItems: 3` 的矛盾，
  增加前台合法能力与越界能力的契约样例。
- 设计稿移至 `design-docs`，当前操作说明保留在 `docs`，历史 home 切换记录移至
  `architecture/review`；README、ADR 和目录约定更新为当前实现。

## Git 收录边界

补收录：线上演示源码和必需资源、脱敏答辩材料、测试入口、迁移/转换新路径、
开发模板缺失的 content-to-storage / content-to-group 公共开发 keyring。

不收录：真实 `.env`、会话导出、真实演示密码、备份、运行时数据、node_modules、dist、
测试报告与日志。原始未脱敏材料和本地 sidecar 残留保存在忽略的
`references/local-archive/pre-cleanup-20260906/`；没有删除用户原始需求档案、赛题资料、
数据库历史迁移或用于历史数据追溯的冻结契约。PDF 渲染使用的字体是实际依赖，予以保留。

凭据检查未在待提交文本中发现已知真实演示密码、常见供应商密钥或私钥标记。
这是有限的模式检查，不等同于完整 Git 历史审计；未重写历史提交。

## 验证

通过：

- Nix 内全 workspace 类型检查、Web 生产构建。
- 契约生成物检查、45 份样例 / 46 份 Schema 校验及权限断言。
- 前端 12 个测试、内容服务测试、共享内容完整性与内部服务测试、存储测试。
- Pi 迁移在临时 PostgreSQL 上连续执行两次；主库 runner 使用首份迁移验证路径及重复执行。
- XLSX 转换输出 49 个知识点、36 个题型、139 道题、73 个错因；清单行数及 SHA-256 匹配。
- 演示引用的本地资源全部存在，Web 构建完整复制这些资源。
- Compose 使用环境模板和仅供配置校验的占位供应商 key 通过 `config --quiet`。
- home 学生/教师只读 API 冒烟：登录、身份、角色隔离、学习读模型和内容列表；测试登录已注销。
- Git 差异空白检查与文件收录检查。

全量测试仍有 **123 通过、7 失败、5 跳过**。以下故障在清理前的基线已存在，
保留原测试，没有通过删除断言或放宽业务行为隐藏故障：

| 测试文件 | 既存问题 |
|---|---|
| `api-next/test/internal-relay.test.ts` | 两个转发测试缺少预期 `nosniff` 响应头 |
| `api-next/test/learning-command-errors.test.ts` | 三个测试涉及错误文本泄漏、已缺失的映射导出及状态码映射 |
| `pi-chat-runtime/test/respond-registration.test.ts` | 测试引用当前实现已不再导出的注册校验函数，文件无法加载 |
| `learning-next/test/artifact-integrity.test.ts` | 历史行兼容放行逻辑与“摘要不符应拒绝”断言冲突 |

五个数据库集成测试因未配置各自专用测试库而跳过。迁移验证使用临时库，没有对线上数据
执行迁移。Web 构建仍提示主 bundle 较大；本次未进行性能重构。
