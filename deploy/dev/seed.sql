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
