-- 0052: 自动组卷通道的试卷 source 允许 'auto'。
-- 0050 仅预留 manual/upload；智能组卷（/papers/auto）新增第三种来源。
begin;

alter table content_paper drop constraint if exists content_paper_source_check;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'content_paper_source_check'
       and conrelid = 'content_paper'::regclass
  ) then
    alter table content_paper
      add constraint content_paper_source_check
      check (source in ('manual', 'upload', 'auto'));
  end if;
end
$$;

insert into infra_schema_migration(version) values ('0052_paper_source_auto') on conflict (version) do nothing;
commit;
