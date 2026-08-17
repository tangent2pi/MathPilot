# policies/ — 运行时 Agent 策略源（pi Skills 目录，设计 §5.1、§1.2.8）

本目录是运行时 Agent 行为策略的**唯一来源**，由 agent-runtime 的 skills.ts 装载
（架构修订 v4：模型身份与动作由 prompts/skills 管理，pi 格式化机制编译）：

```text
policies/
  README.md            本说明
  agent.md             全部任务共用的通用纪律（策略源，版本化；根级 .md = pi skill）
  tasks.manifest.json  任务注册表：task_type → 策略文件 / prompt_version / 模型角色
  tasks/*.md           各任务的角色、输入与输出契约（SKILL.md 规范：--- name/description --- 前导）
  skills/              （阶段 B 起）按需加载的 Skill 包，与任务策略同一管理方式
```

## 管理规则

1. **行为控制只通过策略、Skills 与工作区文件**，不在 Agent 循环里写动作限制；
   循环只负责把编译后的 AGENTS.md（通用纪律 + 工作区地图 + 任务技能）交给 Pi Agent。
2. agent-runtime 启动时装载 manifest 与全部策略文件，缺失/损坏即启动失败
   （不静默回退，Review-001"严禁回退方案"）。
3. 每次策略内容变更必须同步升 `tasks.manifest.json` 中的 `prompt_version`
   （宿主把该版本随 trace 返回，服务写入血缘/判答/画像决策，全链路可审计）。
4. `tasks/*.md` 中的 `{{placeholder}}` 由 skills.ts 在装载时注入任务上下文：
   `question / rubric / userData / fragments / frozenProjection / profileWindow / priorSnapshot / schemaNote`。
5. 新增任务：先写 `tasks/<task>.md`（SKILL.md 前导）+ manifest 注册，再让领域服务经
   `@agmath/providers-model` 调用；领域服务不得内联提示文本。
