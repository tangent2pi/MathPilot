-- 卡片事件记录执行交互的统一用户，而不是一个复制的 student_id。

begin;

alter table pi_card_events add column if not exists actor_user_id text;

update pi_card_events e
set actor_user_id = t.owner_user_id
from pi_threads t
where t.thread_id = e.thread_id
  and e.actor_user_id is null;

alter table pi_card_events alter column actor_user_id set not null;
drop index if exists pi_card_events_student_idx;
alter table pi_card_events drop column if exists student_id;

create index if not exists pi_card_events_actor_idx
  on pi_card_events (tenant_id, actor_user_id, created_at desc);

drop policy if exists pi_card_events_select on pi_card_events;
create policy pi_card_events_select on pi_card_events for select using (
  tenant_id = current_setting('mathpilot.tenant_id', true)
  and exists (
    select 1 from pi_threads t
    where t.thread_id = pi_card_events.thread_id
      and t.tenant_id = pi_card_events.tenant_id
      and (
        t.owner_user_id = current_setting('mathpilot.user_id', true)
        or exists (
          select 1 from pi_thread_acl a
          where a.thread_id = t.thread_id
            and a.tenant_id = t.tenant_id
            and a.user_id = current_setting('mathpilot.user_id', true)
        )
      )
  )
);

drop policy if exists pi_card_events_insert on pi_card_events;
create policy pi_card_events_insert on pi_card_events for insert with check (
  tenant_id = current_setting('mathpilot.tenant_id', true)
  and actor_user_id = current_setting('mathpilot.user_id', true)
  and exists (
    select 1 from pi_threads t
    where t.thread_id = pi_card_events.thread_id
      and t.tenant_id = pi_card_events.tenant_id
      and (
        t.owner_user_id = current_setting('mathpilot.user_id', true)
        or exists (
          select 1 from pi_thread_acl a
          where a.thread_id = t.thread_id
            and a.tenant_id = t.tenant_id
            and a.user_id = current_setting('mathpilot.user_id', true)
            and a.access in ('write', 'admin')
        )
      )
  )
);

commit;
