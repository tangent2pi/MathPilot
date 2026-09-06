import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { contentApi, type CandidateDetail } from "@/lib/content-api";

export function TeacherCandidateReviewCard({ candidateSetId }: { candidateSetId: string }) {
  const client = useQueryClient();
  const key = ["teacher-candidate-review", candidateSetId];
  const query = useQuery({ queryKey: key, queryFn: () => contentApi<CandidateDetail>(`/candidates/${encodeURIComponent(candidateSetId)}`), refetchInterval: 5000 });
  const approval = useMutation({
    mutationFn: () => contentApi(`/candidates/${encodeURIComponent(candidateSetId)}/decide`, { method: "POST", body: JSON.stringify({ decision: "approved" }) }),
    onSuccess: async () => {
      await Promise.all([client.invalidateQueries({ queryKey: key }), client.invalidateQueries({ queryKey: ["teacher-chat", "parse"] }), client.invalidateQueries({ queryKey: ["teacher", "library"] })]);
    },
  });
  const detail = query.data;
  const pending = detail?.candidate.status === "pending_review";
  const annotations = detail?.annotations.some(item => item.state !== "withdrawn");
  const counts = detail?.items.reduce<Record<string, number>>((value, item) => { value[item.entity_kind] = (value[item.entity_kind] ?? 0) + 1; return value; }, {});
  const status = detail ? ({ pending_review: "等待你的审核", approved: "已批准", changes_requested: "已退回修改", superseded: "已有更新版本" })[detail.candidate.status] : "读取审核状态…";
  return <section className="my-4 w-full min-w-0 rounded-2xl border bg-background p-4 text-sm" aria-label="题库包审核">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">{detail?.candidate.phase === "er" ? "错因与诊断规则审核" : "题库抽取审核"}</h3><span className="text-muted-foreground text-xs">{status}</span></div>
    {counts && <p className="text-muted-foreground mt-2">{detail?.candidate.phase === "er" ? `${counts.error_cause ?? 0} 个错因 · ${counts.diagnosis_rule ?? 0} 条诊断规则` : `${counts.question ?? 0} 道题 · ${counts.knowledge ?? 0} 个知识点 · ${counts.question_type ?? 0} 个题型`}</p>}
    {pending && <p className="mt-2">{detail?.candidate.phase === "er" ? "审核通过后生成私有题库包，不会自动发布到班级。" : "请检查题目、来源和去重结果；只有你批准后才开始 ER 分析。"}</p>}
    <div className="mt-3 flex flex-wrap gap-2">
      <Link to={`/content/review/${encodeURIComponent(candidateSetId)}`} className="inline-flex min-h-11 items-center rounded-lg border px-3 font-medium focus-visible:outline-2">查看详情 / 批注修改</Link>
      {pending && <Button className="min-h-11" disabled={approval.isPending || Boolean(annotations)} onClick={() => approval.mutate()}>{approval.isPending ? "正在提交…" : detail?.candidate.phase === "er" ? "批准并生成题库包" : "批准并继续 ER"}</Button>}
      {detail?.er_start_command?.target_thread_id && <Link className="inline-flex min-h-11 items-center px-2 underline" to={`/c/${encodeURIComponent(detail.er_start_command.target_thread_id)}`}>查看 ER 会话</Link>}
    </div>
    {annotations && pending && <p className="text-muted-foreground mt-2 text-xs">存在未处理批注，请进入详情处理后再批准。</p>}
    {(query.error || approval.error) && <p role="alert" className="text-destructive mt-2">{(approval.error || query.error)?.message}</p>}
  </section>;
}
