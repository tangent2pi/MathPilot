-- dev 种子：最小权限应用账号 + dev 租户/用户 + 试点已发布章节包（仅组合根使用）
begin;

do $$
begin
  if not exists (select from pg_roles where rolname = 'agmath_app') then
    create role agmath_app login password 'agmath-app-dev-only';
  end if;
end $$;
grant usage on schema public to agmath_app;
grant select, insert, update, delete on all tables in schema public to agmath_app;

insert into identity_tenant(tenant_id, name)
values ('tnt_dev00001', 'Dev Tenant')
on conflict (tenant_id) do nothing;

insert into identity_user(user_id, tenant_id, oidc_sub, display_name, roles)
values
  ('usr_teacher01', 'tnt_dev00001', 'sub-teacher-dev', 'Dev Teacher', '{teacher,content_reviewer}'),
  ('usr_student01', 'tnt_dev00001', 'sub-student-dev', 'Dev Student', '{student}')
on conflict (user_id) do nothing;

-- ── 试点已发布章节包（设计 §1.1/§7.2：正式学习 Session 只读已发布版本）。
-- 数值经真实模型复核：Q_TRI_012 a=√3,b=2,A=30° → sinB=1/√3，B≈35.3° 或 144.7°（144.7+30<180 ✓）；
-- Q_TRI_020 a=2,b=2√2,A=30° → sinB=√2/2，B=45° 或 135°（135+30<180 ✓）。
-- 内容管线发布（staging→复核→publish）由 e2e 用 chap_tri_real 章节验证；本种子是 dev 直通基线。

insert into content_knowledge_component(dimension_id, tenant_id, name, payload) values
  ('K_SINE_RULE', 'tnt_dev00001', '正弦定理', '{"dimension_id":"K_SINE_RULE","name":"正弦定理"}'),
  ('K_SSA', 'tnt_dev00001', 'SSA 三角形解的讨论', '{"dimension_id":"K_SSA","name":"SSA 三角形解的讨论"}'),
  ('K_TRIANGLE_EXISTENCE', 'tnt_dev00001', '三角形存在条件', '{"dimension_id":"K_TRIANGLE_EXISTENCE","name":"三角形存在条件"}')
on conflict (dimension_id) do nothing;

insert into content_question_type(dimension_id, tenant_id, name, payload) values
  ('T_SSA_SOLVE', 'tnt_dev00001', 'SSA 解三角形', '{"dimension_id":"T_SSA_SOLVE","name":"SSA 解三角形"}')
on conflict (dimension_id) do nothing;

insert into content_error_cause(dimension_id, tenant_id, name, payload) values
  ('E_SSA_MISSING_OBTUSE', 'tnt_dev00001', '遗漏 SSA 补角分支',
   '{"dimension_id":"E_SSA_MISSING_OBTUSE","name":"遗漏 SSA 补角分支","description":"只给锐角解，未讨论补角分支"}')
on conflict (dimension_id) do nothing;

insert into content_diagnosis_rule(rule_id, tenant_id, rule_version, payload) values
  ('R_SSA_BRANCH_CHECK', 'tnt_dev00001', '0.1.0',
   '{"rule_id":"R_SSA_BRANCH_CHECK","trigger":"sinB 值给出单一锐角解","candidate_error_causes":["E_SSA_MISSING_OBTUSE"],"probe":"sinB=x 时 B 的可能值有哪些？"}')
on conflict (rule_id) do nothing;

insert into content_question(question_id, tenant_id, chapter_id, question_version, stem_format, tags, measurement_dims, published, payload) values
  ('Q_TRI_012', 'tnt_dev00001', 'chap_tri_pilot', 1, 'open_solution',
   array['K_SINE_RULE','K_SSA','K_TRIANGLE_EXISTENCE'], array['K_SSA','K_SINE_RULE','K_TRIANGLE_EXISTENCE'], true,
   ('{"question_id":"Q_TRI_012","tenant_id":"tnt_dev00001","chapter_id":"chap_tri_pilot","question_version":1,' ||
   '"stem_markdown":"在△ABC中，已知 a=√3，b=2，A=30°。求角 B（注意讨论解的个数）。","stem_format":"open_solution",' ||
   '"answer":{"summary":"sinB = b·sinA/a = 1/√3，B ≈ 35.3° 或 144.7°，两解均满足 A+B<180°"},' ||
   '"rubric":{"items":[{"id":"setup_sine_rule","description":"正确列出正弦定理并解出 sin B"},{"id":"ssa_branch_check","description":"检验 SSA 补角分支（两解讨论）并确认均满足三角形存在条件"}]},' ||
   '"tags":["K_SINE_RULE","K_SSA","K_TRIANGLE_EXISTENCE"],' ||
   '"measurement_targets":[{"dim":"K_SSA","role":"primary","evidence_rule":"rubric.ssa_branch_check"},{"dim":"K_SINE_RULE","role":"secondary","evidence_rule":"rubric.setup_sine_rule"},{"dim":"K_TRIANGLE_EXISTENCE","role":"prerequisite","evidence_rule":"probe.existence_check"}]}')::jsonb),

  ('Q_TRI_020', 'tnt_dev00001', 'chap_tri_pilot', 1, 'open_solution',
   array['K_SINE_RULE','K_SSA','K_TRIANGLE_EXISTENCE'], array['K_SSA','K_SINE_RULE','K_TRIANGLE_EXISTENCE'], true,
   ('{"question_id":"Q_TRI_020","tenant_id":"tnt_dev00001","chapter_id":"chap_tri_pilot","question_version":1,' ||
   '"stem_markdown":"在△ABC中，已知 a=2，b=2√2，A=30°。求角 B（注意讨论解的个数）。","stem_format":"open_solution",' ||
   '"answer":{"summary":"sinB = b·sinA/a = √2/2，B = 45° 或 135°，两解均满足 A+B<180°"},' ||
   '"rubric":{"items":[{"id":"setup_sine_rule","description":"正确列出正弦定理并解出 sin B"},{"id":"ssa_branch_check","description":"检验 SSA 补角分支（两解讨论）并确认均满足三角形存在条件"}]},' ||
   '"tags":["K_SINE_RULE","K_SSA","K_TRIANGLE_EXISTENCE"],' ||
   '"measurement_targets":[{"dim":"K_SSA","role":"primary","evidence_rule":"rubric.ssa_branch_check"},{"dim":"K_SINE_RULE","role":"secondary","evidence_rule":"rubric.setup_sine_rule"},{"dim":"K_TRIANGLE_EXISTENCE","role":"prerequisite","evidence_rule":"probe.existence_check"}]}')::jsonb)
on conflict (question_id) do nothing;

insert into content_measurement_target(tenant_id, question_id, dim, role, evidence_rule) values
  ('tnt_dev00001', 'Q_TRI_012', 'K_SSA', 'primary', 'rubric.ssa_branch_check'),
  ('tnt_dev00001', 'Q_TRI_012', 'K_SINE_RULE', 'secondary', 'rubric.setup_sine_rule'),
  ('tnt_dev00001', 'Q_TRI_012', 'K_TRIANGLE_EXISTENCE', 'prerequisite', 'probe.existence_check'),
  ('tnt_dev00001', 'Q_TRI_020', 'K_SSA', 'primary', 'rubric.ssa_branch_check'),
  ('tnt_dev00001', 'Q_TRI_020', 'K_SINE_RULE', 'secondary', 'rubric.setup_sine_rule'),
  ('tnt_dev00001', 'Q_TRI_020', 'K_TRIANGLE_EXISTENCE', 'prerequisite', 'probe.existence_check')
on conflict (question_id, dim) do nothing;

-- 血缘：试点题为人工审定内容（设计 §7.3：人工原创也必须记录作者/评审）
insert into content_field_lineage
  (tenant_id, entity_type, entity_id, field_path, derivation_type, provenance_status, reviewer_id, review_decision, confidence)
values
  ('tnt_dev00001', 'question', 'Q_TRI_012', '/stem_markdown', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_TRI_012', '/rubric', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_TRI_012', '/measurement_targets', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_TRI_020', '/stem_markdown', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_TRI_020', '/rubric', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0),
  ('tnt_dev00001', 'question', 'Q_TRI_020', '/measurement_targets', 'teacher_edit', 'human_authored', 'usr_teacher01', 'confirmed', 1.0);

insert into content_chapter_package
  (package_id, tenant_id, version, manifest_hash, published_by, published_at, payload)
values
  ('pkg_tri_pilot_001', 'tnt_dev00001', '0.1.0', 'sha256:pilot-chapter-package-v0.1.0',
   'usr_teacher01', now(),
   ('{"package_id":"pkg_tri_pilot_001","tenant_id":"tnt_dev00001","version":"0.1.0",' ||
   '"contents":{"knowledge_components":["K_SINE_RULE","K_SSA","K_TRIANGLE_EXISTENCE"],' ||
   '"question_types":["T_SSA_SOLVE"],"error_causes":["E_SSA_MISSING_OBTUSE"],' ||
   '"questions":["Q_TRI_012","Q_TRI_020"],"diagnosis_rules":["R_SSA_BRANCH_CHECK"]},' ||
   '"published_by":"usr_teacher01","note":"dev 试点已发布包"}')::jsonb)
on conflict (package_id) do nothing;

commit;

-- ── 演示数据（无模型 key 时可展示报告/计划完整内容；黄金数据，§17.2） ──
insert into state_student_profile (student_id, tenant_id, grade, current_score, target_score, weekly_hours, self_weak, device_draft, payload)
values ('usr_demo01', 'tnt_dev00001', '高二', 95, 115, '4-6', array['K_SSA'], '触屏手写',
  '{"student_id":"usr_demo01","tenant_id":"tnt_dev00001","grade":"高二","current_score":95,"target_score":115,"weekly_hours":"4-6","self_weak":["K_SSA"],"device_draft":"触屏手写"}')
on conflict (student_id) do nothing;

insert into state_profile_update_decision
  (decision_id, tenant_id, student_id, evidence_bundle_id, prior_snapshot_id, supersedes, review_required, model_id, prompt_version, skill_version, payload)
values
  ('pud_demo_0001', 'tnt_dev00001', 'usr_demo01', null, null, null, false, 'demo.model', 'dream-profile@0.4.0', 'profile-skill@0.3.0',
   '{"decision_id":"pud_demo_0001","student_id":"usr_demo01","prior_snapshot_id":null,"baseline_report_refs":["ser_demo_0001"],
     "teaching_summary_refs":["tss_demo_0001"],"dimension_updates":[
       {"dimension_id":"K_SSA","p_baseline":0.42,"p_final":0.62,"state_final":"learning","uncertainty":"medium","evidence_ledger":[]},
       {"dimension_id":"K_SINE_RULE","p_baseline":0.85,"p_final":0.88,"state_final":"possibly_mastered","uncertainty":"low","evidence_ledger":[]}],
     "semantic_profile_updates":[],"review_required":false,"model_id":"demo.model","prompt_version":"dream-profile@0.4.0",
     "skill_version":"profile-skill@0.3.0"}')
on conflict (decision_id) do nothing;

insert into state_profile_decision_validation (validation_id, tenant_id, decision_id, result, validator_version, payload)
values ('pvr_demo_0001', 'tnt_dev00001', 'pud_demo_0001', 'passed', 'profile-validator-0.1.0',
  '{"validation_id":"pvr_demo_0001","decision_id":"pud_demo_0001","result":"passed","validator_version":"profile-validator-0.1.0"}')
on conflict (validation_id) do nothing;

insert into state_student_snapshot (snapshot_id, tenant_id, student_id, source_decision_id, supersedes, profile_lag, payload)
values ('snap_demo_0001', 'tnt_dev00001', 'usr_demo01', 'pud_demo_0001', null, false,
  '{"snapshot_id":"snap_demo_0001","student_id":"usr_demo01","source_decision_id":"pud_demo_0001","supersedes":null,
    "dimensions":[
      {"dimension_id":"K_SSA","p_profile":0.62,"p_bkt_baseline":0.42,"state":"learning","uncertainty":"medium","independent_observation_count":3},
      {"dimension_id":"K_SINE_RULE","p_profile":0.88,"p_bkt_baseline":0.85,"state":"possibly_mastered","uncertainty":"low","independent_observation_count":4}],
    "misconceptions":[],"semantic_profile":{},"profile_lag":false}')
on conflict (snapshot_id) do nothing;

insert into state_mastery_state (tenant_id, student_id, dimension_id, p_profile, state, source_decision_id)
values
  ('tnt_dev00001', 'usr_demo01', 'K_SSA', 0.62, 'learning', 'pud_demo_0001'),
  ('tnt_dev00001', 'usr_demo01', 'K_SINE_RULE', 0.88, 'possibly_mastered', 'pud_demo_0001')
on conflict (student_id, dimension_id) do update set p_profile = excluded.p_profile, state = excluded.state,
  source_decision_id = excluded.source_decision_id, updated_at = now();

insert into state_retention_state (tenant_id, student_id, dimension_id, i90_posterior, next_review_due, stable)
values ('tnt_dev00001', 'usr_demo01', 'K_SSA',
  '{"0.5":0.125,"1":0.125,"2":0.125,"4":0.125,"8":0.125,"16":0.125,"32":0.125,"64":0.125}', null, false)
on conflict (student_id, dimension_id) do nothing;

insert into state_misconception_state (tenant_id, student_id, error_cause_id, state, evidence_refs)
values ('tnt_dev00001', 'usr_demo01', 'E_SSA_MISSING_OBTUSE', 'suspected', '["claim://clm_demo_0001"]')
on conflict (student_id, error_cause_id) do nothing;

insert into state_learning_plan (plan_id, tenant_id, student_id, horizon_weeks, payload)
values ('pln_demo_0001', 'tnt_dev00001', 'usr_demo01', 4,
  '{"plan_id":"pln_demo_0001","student_id":"usr_demo01","tenant_id":"tnt_dev00001","horizon_weeks":4,
    "explanation":"先补 SSA 解的个数讨论（分类讨论专项），再练正弦定理迁移，最后延迟复测验证保持率。",
    "tasks":[
      {"week":1,"kind":"knowledge_review","dimension_ids":["K_SSA"],"criterion":"能独立复述 SSA 两解判定条件","review_condition":"下周低档练习正确率≥0.7","minutes":30},
      {"week":1,"kind":"practice_easy","dimension_ids":["K_SSA"],"criterion":"低一档练习正确率≥0.7","review_condition":"达标后进入原难度练习","minutes":30},
      {"week":2,"kind":"practice_normal","dimension_ids":["K_SSA"],"criterion":"原难度练习正确率≥0.7 且无提示","review_condition":"独立复测到期后验证","minutes":30},
      {"week":3,"kind":"practice_normal","dimension_ids":["K_SINE_RULE"],"criterion":"原难度综合题正确率≥0.7","review_condition":"周4迁移题验证","minutes":30},
      {"week":4,"kind":"transfer","dimension_ids":["K_SINE_RULE"],"criterion":"跨表征/题型独立迁移成功","review_condition":"迁移成功进入证据账本","minutes":30},
      {"week":4,"kind":"delayed_review","dimension_ids":["K_SSA"],"criterion":"独立延迟复测（无提示）","review_condition":"复测结果更新保持率后验","minutes":30}]}')
on conflict (plan_id) do nothing;
