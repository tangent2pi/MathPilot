# AGENTS.md — 数学智元（MathPilot）开发约定

本文件面向在仓库内工作的开发 Agent 与人类协作者，声明项目开发环境和目录边界。

## 开发环境：必须通过 `nix develop`

- 项目的开发、构建、测试统一在 Nix 开发环境中进行。
- 进入开发环境：

  ```sh
  nix develop
  ```

  环境由根目录 [`flake.nix`](./flake.nix) 定义，依赖版本由 `flake.lock` 锁定。
- 单条命令可使用：

  ```sh
  nix develop -c <命令>
  ```

## 按需添加工具或库

- 优先把持续使用的工具加入 `flake.nix`；一次性工具使用 `nix run nixpkgs#<工具> -- ...`。
- 如果仓库环境无法提供所需工具，可以在 `nix develop` 内使用对应项目的临时包执行器，不要全局安装。
- 与任务相关且不引入冲突的 Nix 工具可直接添加；若 `flake.lock` 发生变化，应一并提交。

## 目录约定

- [`references/`](./references) 统一存放开源项目源码副本和队友参考材料，仅供阅读，不得被产品源码直接依赖；该目录不进入 Git。
- [`src/`](./src) 存放正式应用、服务和包；[`db/`](./db) 存放 PostgreSQL 迁移；[`deploy/dev/`](./deploy/dev) 是唯一开发组合根。
- [`competition-info/`](./competition-info) 存放赛题原始资料；[`design-docs/`](./design-docs) 存放产品和架构设计，其中 `原始对话/` 是只读需求档案。
- [`data/`](./data) 是从 PostgreSQL 导出的结构化快照，不是运行时事实源。

## 命名约定

用户可见品牌与工程标识统一为“数学智元 / MathPilot”。协议 Schema、数据库角色/函数、环境变量、容器路径和浏览器存储键统一使用 `mathpilot` 命名空间。
