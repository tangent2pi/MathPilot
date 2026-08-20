#!/usr/bin/env bash
# 公共内容、教师内容、学生绑定与 Agent 数据库身份的确定性权限回归。
# 只在单个事务内创建测试主体和授权，结束时回滚，不调用模型或 OCR。
set -eu

POSTGRES_CONTAINER="${POSTGRES_CONTAINER:-agmath-dev-postgres-1}"

docker exec -i "$POSTGRES_CONTAINER" psql -U agmath -d agmath -v ON_ERROR_STOP=1 -P pager=off <<'SQL'
begin;

insert into identity_user(user_id,tenant_id,oidc_sub,display_name,roles)
values('usr_scope_teacher02','tnt_dev00001','scope-teacher-02','范围测试教师','{teacher}')
on conflict(user_id) do nothing;

insert into content_knowledge_component(dimension_id,tenant_id,name,payload)
values
  ('K_SCOPE_SMOKE_PRIVATE','tnt_dev00001','私有范围测试','{}'),
  ('K_SCOPE_SMOKE_PUBLIC','tnt_dev00001','公共范围测试','{}');
insert into content_entity_scope(tenant_id,entity_type,entity_id,visibility,owner_teacher_id)
values
  ('tnt_dev00001','knowledge_component','K_SCOPE_SMOKE_PRIVATE','teacher','usr_teacher01'),
  ('tnt_dev00001','knowledge_component','K_SCOPE_SMOKE_PUBLIC','public',null);

select agmath_provision_agent_identity('tnt_dev00001','content','usr_teacher01','scope-test-password');
select agmath_provision_agent_identity('tnt_dev00001','content','usr_scope_teacher02','scope-test-password');

set session authorization agmath_agent_content_tnt_dev00001_usr_teacher01;
do $$ begin
  if jsonb_array_length(agmath_agent_library('knowledge','K_SCOPE_SMOKE_PRIVATE',100,0)->'items') <> 1 then
    raise exception 'owner teacher did not see private content';
  end if;
end $$;
reset session authorization;

set session authorization agmath_agent_content_tnt_dev00001_usr_scope_teacher02;
do $$ begin
  if jsonb_array_length(agmath_agent_library('knowledge','K_SCOPE_SMOKE_PRIVATE',100,0)->'items') <> 0 then
    raise exception 'unrelated teacher saw private content';
  end if;
end $$;
reset session authorization;

set session authorization agmath_agent_tnt_dev00001_usr_student01;
do $$ begin
  if jsonb_array_length(agmath_agent_library('knowledge','K_SCOPE_SMOKE_PRIVATE',100,0)->'items') <> 0 then
    raise exception 'unbound student saw private knowledge';
  end if;
  if jsonb_array_length(agmath_agent_library('knowledge','K_SCOPE_SMOKE_PUBLIC',100,0)->'items') <> 1 then
    raise exception 'unbound student did not receive public knowledge';
  end if;
end $$;
reset session authorization;

insert into identity_teacher_student_binding(binding_id,tenant_id,teacher_id,student_id,status,created_by)
values('bind_scope_smoke','tnt_dev00001','usr_teacher01','usr_student01','active','usr_teacher01');

set session authorization agmath_agent_tnt_dev00001_usr_student01;
do $$ begin
  if jsonb_array_length(agmath_agent_library('knowledge','K_SCOPE_SMOKE_PRIVATE',100,0)->'items') <> 1 then
    raise exception 'bound student did not receive teacher knowledge';
  end if;
end $$;
reset session authorization;

update identity_teacher_student_binding
set status='revoked',revoked_by='usr_teacher01',revoked_at=now()
where binding_id='bind_scope_smoke';

set session authorization agmath_agent_tnt_dev00001_usr_student01;
do $$ begin
  if jsonb_array_length(agmath_agent_library('knowledge','K_SCOPE_SMOKE_PRIVATE',100,0)->'items') <> 0 then
    raise exception 'revoked binding still exposed teacher content';
  end if;
end $$;
reset session authorization;

insert into content_entity_scope(tenant_id,entity_type,entity_id,visibility,owner_teacher_id)
values('tnt_dev00001','knowledge_component','K_SCOPE_SMOKE_PUBLIC','teacher','usr_teacher01');

set session authorization agmath_agent_content_tnt_dev00001_usr_teacher01;
do $$ begin
  if jsonb_array_length(agmath_agent_library('knowledge','K_SCOPE_SMOKE_PUBLIC',100,0)->'items') <> 1 then
    raise exception 'overlapping public and teacher grants duplicated an entity';
  end if;
end $$;
reset session authorization;

rollback;
select 'CONTENT SCOPE SMOKE PASS' as result;
SQL
