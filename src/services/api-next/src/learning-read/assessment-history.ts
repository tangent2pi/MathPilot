/** Same read-model columns as question sessions, without forging science facts.
 * $1 is tenant, $3 filter, $5 the already-authorized subject's identity user ID. */
export const assessmentHistorySql = `
  select a.answer_id question_session_id,
    coalesce(a.auto_grade->>'conversation_thread_id',r.conversation_thread_id) conversation_thread_id,
    a.question_revision_id,'self_test'::text source,'closed'::text lifecycle,
    r.status::text close_reason,a.submitted_at opened_at,a.submitted_at closed_at,
    a.fact_version version,q.stem_markdown || coalesce((select E'\n\n' || string_agg(o.option_key || '. ' || o.option_text,E'\n\n' order by i.position)
      from content_revision_item i join content_question_option o using(item_id)
      where i.tenant_id=q.tenant_id and i.revision_id=q.revision_id and i.item_kind='question_option'),'') stem_markdown,
    a.answer_id attempt_id,'self_test'::text attempt_kind,
    case when a.independent then 0 else 1 end hint_level,a.submitted_at,
    a.answer_id judgment_id,a.verdict::text,null::text uncertainty,
    a.auto_grade->>'rationale' decision_summary,null::text diagnostic_status,a.response_text
  from science_v3_self_test_answer a
  join science_v3_self_test_run r on r.tenant_id=a.tenant_id and r.run_id=a.run_id and r.user_id=a.user_id
  left join content_question_revision q on q.tenant_id=a.tenant_id and q.revision_id=a.question_revision_id
  where a.tenant_id=$1 and a.user_id=$5
    and ($3 in ('all','self_test') or ($3='independent' and a.independent) or ($3='error' and a.verdict='incorrect'))
  union all
  select r.run_id || ':current',coalesce(r.state->>'evidence_thread_id',r.conversation_thread_id),
    r.state->'current_question'->>'revision_id','self_test','active',null::text,
    r.updated_at,null::timestamptz,r.version,q.stem_markdown || coalesce((select E'\n\n' || string_agg(o.option_key || '. ' || o.option_text,E'\n\n' order by i.position)
      from content_revision_item i join content_question_option o using(item_id)
      where i.tenant_id=q.tenant_id and i.revision_id=q.revision_id and i.item_kind='question_option'),''),
    null::text,null::text,null::int,null::timestamptz,null::text,null::text,null::text,null::text,null::text,null::text
  from science_v3_self_test_run r
  left join content_question_revision q on q.tenant_id=r.tenant_id and q.revision_id=r.state->'current_question'->>'revision_id'
  where r.tenant_id=$1 and r.user_id=$5 and r.status='active'
    and r.state->'current_question'->>'revision_id' is not null and $3 in ('all','self_test')
`;
