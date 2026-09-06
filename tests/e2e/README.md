# 在线验证

所有本地命令通过 `nix develop` 执行。普通测试用 `pnpm test`，不需要供应商密钥。

## 当前接口只读冒烟

在 shell 环境中设置 `BASE`（默认 `http://localhost:8080`）、
`BETTER_AUTH_STUDENT_EMAIL/PASSWORD` 和 `BETTER_AUTH_TEACHER_EMAIL/PASSWORD`，运行：

```sh
nix develop -c pnpm test:e2e
```

检查登录、角色隔离、学习读模型及教师内容列表。不要求固定题量或固定用户 ID，
不创建对话、测评或内容，不调用模型/OCR；仅创建并在结束时注销测试登录会话。
凭据不要写进文件或命令行参数。

## 容器沙箱冒烟

`agent-tools-smoke.mjs` 在 learning-next 镜像中验证真实沙箱的 Bash、读写、SymPy 和宿主隔离。
将仓库 `tests/` 只读挂载到 `/app/tests`，以 `/app/src/services/learning-next` 为工作目录执行：

```sh
node --import tsx /app/tests/e2e/agent-tools-smoke.mjs
```

脚本不调用模型或数据库，结束时清理临时工作区。旧 `/api/sessions`、批处理内容流水线、
直接 HTTP 判答与固定 CDP 会话的脚本已退役，可从清理前提交 `09f5c3c` 查阅。
