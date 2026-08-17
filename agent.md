# AGENTS / agent.md — 给开发 agent 的说明

本文件向所有在此仓库工作的开发 agent（Claude Code、Codex、pi、其他 AI 编码 agent 及人类协作者）声明本项目的开发环境与约定。

## 开发环境：必须通过 `nix develop`

- 本项目的开发、构建、测试统一在 **nix 开发环境**中进行。
- 进入开发环境：在仓库根目录执行

  ```sh
  nix develop
  ```

  环境由根目录的 [`flake.nix`](./flake.nix) 定义（`flake.lock` 锁定依赖版本）。
- 所有需要运行命令的操作（构建、测试、脚本等）都应在此环境内执行。
- 也可以用非交互方式执行单条命令：

  ```sh
  nix develop -c <命令>
  ```

## 按需添加工具或库（agent 可自主进行）

- 需要新的工具或库时，**agent 可以自行通过 nix 添加**，无需等待人类确认，前提是添加内容与当前任务相关且不引入冲突。
- 推荐方式：编辑根目录 [`flake.nix`](./flake.nix)，在 `mkShell` 的 `packages` 列表中按需添加，例如：

  ```nix
  pkgs.ripgrep
  pkgs.python312
  pkgs.nodejs
  ```

  然后重新执行 `nix develop`（首次添加会自动更新 `flake.lock`）。
- 临时使用某个工具而不修改 flake：

  ```sh
  nix shell nixpkgs#<包名> -c <命令>
  # 或
  nix develop -c nix-shell -p <包名> --run '<命令>'
  ```

- 添加工具后，如产生了 `flake.lock` 变更，请一并提交。

## 目录约定

- [`references/`](./references) 存放 codex、pi agent 等开源项目的源码副本与队友贡献的简要模型（`references/teammate-models/`），**仅供阅读参考**，不要修改、不要直接依赖其中的代码；该目录已加入 `.gitignore`，不参与本仓库版本管理。
- [`competition-info/`](./competition-info) 存放赛题说明、官网信息与参赛数据；[`design-docs/`](./design-docs) 存放设计文档（`design-docs/原始对话/` 为 ChatGPT 对话原始导出，`design-docs/设计文档汇总.md` 为对全部对话与建模文档的完整总结）。
