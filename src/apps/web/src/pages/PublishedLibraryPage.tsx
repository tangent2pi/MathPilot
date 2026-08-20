import { useQuery } from "@tanstack/react-query";
import { BookOpenCheck, ChevronRight } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { EmptyState } from "../components/feedback/EmptyState";
import { BackButton } from "../components/BackButton";
import { MathText } from "../components/MathText";
import { apiFetch, formatDate } from "../lib/api";
import { stemFormatLabel } from "../lib/content";

type PackageSummary = {
  package_id: string;
  chapter_id: string;
  version: string;
  published_at: string;
  visibility: "public" | "teacher";
  question_count: number;
  knowledge_count: number;
  question_type_count: number;
  error_cause_count: number;
  diagnosis_rule_count: number;
};
type EntityRow = { dimension_id: string; name?: string; payload?: Record<string, unknown> };
type RuleRow = { rule_id: string; payload?: Record<string, unknown> };
type QuestionRow = {
  question_id: string;
  stem_format: string;
  asset_count?: number;
  payload?: {
    stem_markdown?: string;
    stem_format?: string;
    options?: Array<{ key?: string; text_markdown?: string }>;
    answer?: unknown;
    question_type?: { id?: string; name?: string };
    measurement_targets?: Array<{ dim?: string; role?: string }>;
  };
};
type PackageDetail = {
  package: PackageSummary & { manifest_hash?: string };
  questions: QuestionRow[];
  knowledge_components: EntityRow[];
  question_types: EntityRow[];
  error_causes: EntityRow[];
  diagnosis_rules: RuleRow[];
};

const tabs = [
  ["questions", "题目"],
  ["knowledge_components", "知识点"],
  ["question_types", "题型"],
  ["error_causes", "错因"],
  ["diagnosis_rules", "诊断规则"],
] as const;

function EntityList({ packageId, type, rows }: { packageId: string; type: "knowledge_component" | "question_type" | "error_cause"; rows: EntityRow[] }) {
  return <div className="library-entity-list">{rows.map((row) => <article className="library-entity" key={row.dimension_id}>
    <div><span className="mono">{row.dimension_id}</span><h3>{row.name || String(row.payload?.name || "未命名内容")}</h3></div>
    {typeof row.payload?.description === "string" && <p>{row.payload.description}</p>}
    <Link className="text-link" to={`/library/${encodeURIComponent(packageId)}/${type}/${encodeURIComponent(row.dimension_id)}`}>查看详细信息 <ChevronRight aria-hidden="true" /></Link>
  </article>)}</div>;
}

export function PublishedLibraryPage() {
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState<(typeof tabs)[number][0]>("questions");
  const packages = useQuery({ queryKey: ["content-packages"], queryFn: () => apiFetch<{ packages?: PackageSummary[] }>("/api/content/packages") });
  const packageList = useMemo(() => packages.data?.packages ?? [], [packages.data?.packages]);
  const requested = params.get("package") || "";
  const activeId = requested || packageList[0]?.package_id || "";
  useEffect(() => {
    if (!requested && activeId) setParams((current) => { const next = new URLSearchParams(current); next.set("package", activeId); return next; }, { replace: true });
  }, [activeId, requested, setParams]);
  const detail = useQuery({
    queryKey: ["content-package", activeId],
    queryFn: () => apiFetch<PackageDetail>(`/api/content/packages/${encodeURIComponent(activeId)}`),
    enabled: Boolean(activeId),
  });
  const counts: Record<(typeof tabs)[number][0], number> = {
    questions: detail.data?.questions.length ?? 0,
    knowledge_components: detail.data?.knowledge_components.length ?? 0,
    question_types: detail.data?.question_types.length ?? 0,
    error_causes: detail.data?.error_causes.length ?? 0,
    diagnosis_rules: detail.data?.diagnosis_rules.length ?? 0,
  };

  return <main className="page page-stack published-library" id="main-content">
    <BackButton fallback="/content" />
    <section className="page-hero compact"><p className="eyebrow">内容库</p><h1>已发布内容</h1><p className="lede">查看已经提供给学生使用的题目、知识点、题型和诊断内容。</p></section>
    {packages.isPending ? <div className="pending-line"><span className="spinner" />正在读取已发布内容…</div> : packageList.length === 0 ? <EmptyState title="还没有已发布内容" action={<Link className="btn cinnabar" to="/content">整理教学资料</Link>}>完成内容复核并发布后，内容版本会显示在这里。</EmptyState> : <div className="library-workspace">
      <aside className="library-package-list" aria-label="内容版本">
        <div className="section-heading"><div><p className="eyebrow">内容版本</p><h2>{packageList.length} 个版本</h2></div></div>
        {packageList.map((item) => <button className={`package-picker ${item.package_id === activeId ? "is-active" : ""}`} key={item.package_id} type="button" onClick={() => setParams({ package: item.package_id })}>
          <BookOpenCheck aria-hidden="true" /><span><strong>版本 {item.version}</strong><small>{item.question_count} 道题 · {formatDate(item.published_at)}</small></span><ChevronRight aria-hidden="true" />
        </button>)}
      </aside>
      <section className="section-card library-detail">
        {detail.isPending ? <div className="pending-line"><span className="spinner" />正在打开内容版本…</div> : detail.isError || !detail.data ? <EmptyState title="无法打开这个内容版本">请返回内容工坊确认发布状态，或稍后重试。</EmptyState> : <>
          <div className="section-heading"><div><p className="eyebrow">{detail.data.package.visibility === "public" ? "公共内容" : "我的教学内容"}</p><h2>版本 {detail.data.package.version}</h2><p className="muted">发布于 {formatDate(detail.data.package.published_at)} · {detail.data.package.chapter_id}</p></div><Link className="btn ghost" to="/content">返回内容工坊</Link></div>
          <nav className="library-tabs" aria-label="内容分类">{tabs.map(([id, label]) => <button type="button" key={id} aria-selected={tab === id} onClick={() => setTab(id)}>{label}<span>{counts[id]}</span></button>)}</nav>
          {tab === "questions" && <div className="published-question-list">{detail.data.questions.map((question) => {
            const payload = question.payload ?? {};
            return <Link className="published-question-link" key={question.question_id} to={`/library/${encodeURIComponent(activeId)}/question/${encodeURIComponent(question.question_id)}`}><span className="question-kind">{stemFormatLabel[payload.stem_format || question.stem_format] || "题目"}</span><MathText as="span" text={payload.stem_markdown || question.question_id} /><span className="published-question-meta"><span className="mono">{question.question_id}</span>{Number(question.asset_count || 0) ? `${question.asset_count} 张题图` : "查看详细信息"}</span><ChevronRight aria-hidden="true" /></Link>;
          })}</div>}
          {tab === "knowledge_components" && <EntityList packageId={activeId} type="knowledge_component" rows={detail.data.knowledge_components} />}
          {tab === "question_types" && <EntityList packageId={activeId} type="question_type" rows={detail.data.question_types} />}
          {tab === "error_causes" && <EntityList packageId={activeId} type="error_cause" rows={detail.data.error_causes} />}
          {tab === "diagnosis_rules" && <div className="library-entity-list">{detail.data.diagnosis_rules.map((row) => <article className="library-entity" key={row.rule_id}><div><span className="mono">{row.rule_id}</span><h3>{String(row.payload?.trigger || "诊断规则")}</h3></div>{typeof row.payload?.probe === "string" && <p>确认问题：{row.payload.probe}</p>}<Link className="text-link" to={`/library/${encodeURIComponent(activeId)}/diagnosis_rule/${encodeURIComponent(row.rule_id)}`}>查看详细信息 <ChevronRight aria-hidden="true" /></Link></article>)}</div>}
        </>}
      </section>
    </div>}
  </main>;
}
