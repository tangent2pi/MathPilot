-- 0058: AgentAttempt 记录本次前台任务真实执行过的工具轨迹。
-- 用途：回复落库时把工具序列作为权威消息的一部分写入 canonical message
-- （前端按 assistant-ui 消息模型渲染 tool-call parts，刷新/重开一致）。
-- tool_trace 是展示事实，不参与科学状态计算。
begin;

alter table science_v3_agent_attempt
  add column tool_trace jsonb
    check (tool_trace is null or jsonb_typeof(tool_trace) = 'array');

comment on column science_v3_agent_attempt.tool_trace is
  '前台任务真实工具调用序列：[{name,state("done"|"error")}]；由 executor 在会话收敛后写入';

insert into infra_schema_migration(version) values ('0058_agent_attempt_tool_trace');
commit;
