import { useQuery } from "@tanstack/react-query";
import { BookOpenCheck } from "lucide-react";
import { Link, useParams } from "react-router-dom";
import { BackButton } from "../components/BackButton";
import { EmptyState } from "../components/feedback/EmptyState";
import { MathText } from "../components/MathText";
import { apiFetch, formatDate } from "../lib/api";
import { formatAnswer, optionLabel, reviewTypeLabel, stemFormatLabel } from "../lib/content";

type EntityRow = { dimension_id: string; name?: string; payload?: Record<string, any> };
type RuleRow = { rule_id: string; payload?: Record<string, any> };
type QuestionRow = { question_id: string; stem_format: string; payload?: Record<string, any> };
type PackageDetail = {
  package: { package_id: string; version: string; published_at: string; visibility: string };
  questions: QuestionRow[];
  knowledge_components: EntityRow[];
  question_types: EntityRow[];
  error_causes: EntityRow[];
  diagnosis_rules: RuleRow[];
};
type QuestionDetail = Record<string, any> & {
  payload?: Record<string, any>;
  dimension_names?: Record<string, { name: string; type: "knowledge_component" | "question_type" }>;
  assets?: Array<{ asset_id?: string; image_data_url?: string; page_no?: number }>;
};

const validTypes = new Set(["question", "knowledge_component", "question_type", "error_cause", "diagnosis_rule"]);

export function PublishedContentDetailPage() {
  const { packageId = "", type = "", id = "" } = useParams();
  const valid = Boolean(packageId && id && validTypes.has(type));
  const detail = useQuery({ queryKey: ["content-package", packageId], queryFn: () => apiFetch<PackageDetail>(`/api/content/packages/${encodeURIComponent(packageId)}`), enabled: valid });
  const questionDetail = useQuery({ queryKey: ["published-question-detail", id], queryFn: () => apiFetch<QuestionDetail>(`/api/content/questions/${encodeURIComponent(id)}/review`), enabled: valid && type === "question" });
  const fallback = `/library?package=${encodeURIComponent(packageId)}`;

  if (!valid) return <main className="page narrow page-stack" id="main-content"><BackButton fallback="/library" /><EmptyState title="无法打开详细信息">内容地址不完整，请返回内容库重新选择。</EmptyState></main>;
  if (detail.isPending || (type === "question" && questionDetail.isPending)) return <main className="page narrow page-stack" id="main-content"><BackButton fallback={fallback} label="返回已发布内容" /><div className="pending-line"><span className="spinner" />正在读取详细信息…</div></main>;
  if (!detail.data) return <main className="page narrow page-stack" id="main-content"><BackButton fallback={fallback} label="返回已发布内容" /><EmptyState title="没有找到这项内容">它可能已被撤回，或不在当前可见范围内。</EmptyState></main>;

  const packageInfo = detail.data.package;
  const nameById = new Map([
    ...detail.data.knowledge_components.map((row) => [row.dimension_id, row.name || String(row.payload?.name || row.dimension_id)] as const),
    ...detail.data.question_types.map((row) => [row.dimension_id, row.name || String(row.payload?.name || row.dimension_id)] as const),
  ]);

  let body = <EmptyState title="没有找到这项内容">请返回内容库重新选择。</EmptyState>;
  let title = id;
  let kind = reviewTypeLabel[type] || "内容";

  if (type === "question") {
    const row = detail.data.questions.find((item) => item.question_id === id);
    // Current content responses are flattened; the nested payload remains a
    // compatibility fallback for older deployments.
    const payload = { ...(row?.payload ?? {}), ...(questionDetail.data ?? {}), ...(questionDetail.data?.payload ?? {}) };
    const targets = Array.isArray(payload.measurement_targets) ? payload.measurement_targets : [];
    const options = Array.isArray(payload.options) ? payload.options : [];
    const rubricItems = Array.isArray(payload.rubric?.items) ? payload.rubric.items : [];
    title = payload.stem_markdown || id;
    kind = stemFormatLabel[payload.stem_format || row?.stem_format] || "题目";
    body = row ? <div className="published-detail-sections">
      <section><div className="content-label">题目</div><MathText as="h2" text={title} /></section>
      {!!questionDetail.data?.assets?.length && <section><div className="content-label">题图</div><div className="review-image-grid">{questionDetail.data.assets.map((asset, index) => <figure key={asset.asset_id || index}>{asset.image_data_url && <img src={asset.image_data_url} alt={`题图 ${index + 1}`} width="1200" height="900" loading="lazy" decoding="async" />}<figcaption>{asset.page_no ? `原资料第 ${asset.page_no} 页` : `题图 ${index + 1}`}</figcaption></figure>)}</div></section>}
      {!!options.length && <section><div className="content-label">选项</div><ol className="answer-options">{options.map((option: any, index: number) => <li key={option.key || index}><strong>{optionLabel(index, option.key)}</strong><MathText text={option.text_markdown || ""} /></li>)}</ol></section>}
      <section><div className="content-label">参考答案</div><MathText text={formatAnswer(payload.answer)} /></section>
      {!!rubricItems.length && <section><div className="content-label">解题要点</div><ol className="solution-outline">{rubricItems.map((item: any, index: number) => <li key={item.id || index}><MathText text={item.description || ""} /></li>)}</ol></section>}
      <section><div className="content-label">知识关联</div><div className="knowledge-links">{targets.map((target: any) => {
        const dimension = questionDetail.data?.dimension_names?.[target.dim];
        const targetType = dimension?.type || (String(target.dim).startsWith("T_") ? "question_type" : "knowledge_component");
        return <Link key={target.dim} to={`/library/${encodeURIComponent(packageId)}/${targetType}/${encodeURIComponent(target.dim)}`}>{dimension?.name || nameById.get(target.dim) || target.dim}</Link>;
      })}</div></section>
    </div> : body;
  } else if (type === "diagnosis_rule") {
    const row = detail.data.diagnosis_rules.find((item) => item.rule_id === id);
    title = String(row?.payload?.trigger || id);
    body = row ? <div className="published-detail-sections"><section><div className="content-label">触发条件</div><MathText as="h2" text={title} /></section><section><div className="content-label">确认问题</div><MathText text={String(row.payload?.probe || "暂未提供")} /></section></div> : body;
  } else {
    const rows = type === "knowledge_component" ? detail.data.knowledge_components : type === "question_type" ? detail.data.question_types : detail.data.error_causes;
    const row = rows.find((item) => item.dimension_id === id);
    title = row?.name || String(row?.payload?.name || id);
    body = row ? <div className="published-detail-sections"><section><div className="content-label">名称</div><h2>{title}</h2></section>{row.payload?.description && <section><div className="content-label">说明</div><MathText text={String(row.payload.description)} /></section>}</div> : body;
  }

  return <main className="page narrow page-stack published-content-detail" id="main-content">
    <BackButton fallback={fallback} label="返回已发布内容" />
    <section className="page-hero compact"><p className="eyebrow">已发布内容</p><h1>{kind}详细信息</h1><p className="lede"><BookOpenCheck aria-hidden="true" />版本 {packageInfo.version} · 发布于 {formatDate(packageInfo.published_at)}</p></section>
    <section className="section-card">{body}</section>
  </main>;
}
