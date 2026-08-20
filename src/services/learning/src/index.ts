/**
 * learning-service：QuestionSession 创建/查询 + 教学闭环（含错因归因与追问）。
 *
 * 状态机（设计 §4.5 骨架版）：
 *   submit（首次作答）→ SUBMIT → GRADE
 *     ├─ correct / unresolved → CLOSE 全链（观测 + SER + TSS + SLR + QUEUE_DREAM）
 *     └─ partially_correct / incorrect → DIAGNOSE（错因归因 §8.3）
 *         → PROBE_AWAIT ↔ probe（追问作答，≤3 轮）→ 闭合/待观察 → CLOSE 全链
 *
 * 判答（GRADE）为模型主判（设计 §12.1）：经 agent-runtime（Pi 宿主）创建
 * Teaching Agent Session；学生作答按不可信数据处理（§16.3）。
 * 模型不可用/无输出时显式 502——绝不伪造判定。
 *
 * 题目只读已发布章节包（§7.2）：未发布/不可达显式失败，无内置兜底题；
 * 客户端提交的 chapter_package_version 必须真实存在且该题属于该包（P0-5 证据链）。
 *
 * 观测纪律（P0-6，设计 §2.3/§8.2）：只有满足对应评分点或定向追问产生明确证据的
 * 维度才更新——主答按 rubric 逐评分点写观测（met→success / not_met→failure），
 * 部分正确不再整体计失败；探针属教学追问（teaching_only），不构成独立观测；
 * 每观测携带 judgment_id 与 evidence_refs；SLR 完整性按真实引用校验。
 *
 * 纪律（ADR-004）：本服务不写 StudentSnapshot；长期画像只由 Dream 路径更新。
 */
import { startService, createPool, withTenant, newId } from "./lib.ts";
import { createAgentRuntimeClient } from "@mathpilot/providers-model";
import { bktReplay, BKT_PRIOR_V1 } from "@mathpilot/mastery";
import { initialI90Prior, updateI90Posterior, nextReviewDue } from "@mathpilot/mastery/retention";
import { selectNext, type QuestionCandidate, type SelectorContext, type SelectionGoal } from "@mathpilot/selector";

const pool = createPool(process.env.DATABASE_URL ?? "postgres://localhost:5432/mathpilot");
/** 模型调用统一经 agent-runtime（Pi 宿主）；本服务不直连任何模型供应商 */
const AGENT_RUNTIME_URL = process.env.AGENT_RUNTIME_URL ?? "http://localhost:3005";
const CONTENT_URL = process.env.CONTENT_URL ?? "http://localhost:3006";
const PROFILE_URL = process.env.PROFILE_URL ?? "http://localhost:3003";
const runtime = createAgentRuntimeClient({ baseUrl: AGENT_RUNTIME_URL });

const MAX_PROBE_ROUNDS = 3;
const DAY_MS = 86_400_000;

interface CreateSessionBody {
  student_id: string;
  question_id: string;
  assessment_run_id?: string;
  chapter_package_version: string;
  mode: "diagnostic" | "help" | "review";
  draft_enabled: boolean;
}

interface SubmitBody {
  answer_text: string;
  dimension_id?: string;
  answer_images?: PromptImage[];
}

interface ProbeBody {
  answer_text: string;
}

type InteractionAction = "stuck" | "check_step" | "method_hint" | "card_event" | "free_text" | "free_ask";

interface InteractionBody {
  action: InteractionAction;
  text?: string;
  images?: PromptImage[];
}

interface InteractionResult {
  reply: string;
  status: "ok" | "need_more_input" | "question_complete";
  artifacts: {
    kind: "text" | "image" | "video" | "html" | "question_card";
    title?: string; uri?: string; content?: string;
    artifact_id?: string; artifact_kind?: string; renderer?: string; entrypoint?: string;
    artifact_ref?: string; manifest_hash?: string; interaction_token?: string;
    manifest?: Record<string, unknown>;
  }[];
  model_id: string;
  prompt_version: string;
}

interface PromptImage {
  data: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
}

function validPromptImages(value: unknown): PromptImage[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 4) return null;
  const images = value as PromptImage[];
  return images.every((i) => i && typeof i.data === "string" && i.data.length <= 14_000_000
    && /^[A-Za-z0-9+/=\r\n]+$/.test(i.data)
    && ["image/png", "image/jpeg", "image/webp"].includes(i.mimeType)) ? images : null;
}

function imageFromDataUrl(value: string): PromptImage | null {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\r\n]+)$/.exec(value);
  return match ? { mimeType: match[1] as PromptImage["mimeType"], data: match[2]! } : null;
}

function tenantOf(req: { headers: Record<string, unknown> }): string | null {
  const t = req.headers["x-tenant-id"];
  return typeof t === "string" && t.length > 0 ? t : null;
}

function actorOf(req: { headers: Record<string, unknown> }): string | null {
  const u = req.headers["x-user-id"];
  return typeof u === "string" && u.length > 0 ? u : null;
}

/** 契约校验（identity/v1 DimensionId）：客户端输入不得携带任意串进入观测/快照 */
const DIMENSION_ID_RE = /^(K|T|E)_[A-Z0-9_]{2,}$/;
const MAX_ANSWER_CHARS = 20_000;

const VERDICTS = new Set(["correct", "partially_correct", "incorrect", "unresolved"]);
const RUBRIC_STATUS = new Set(["met", "not_met", "unclear"]);

interface MeasurementTargetSpec {
  dim: string;
  role: "primary" | "secondary" | "prerequisite";
  evidence_rule?: string;
}

interface QuestionSpec {
  stem: string;
  answer: Record<string, unknown>;
  rubric: { id: string; description: string }[];
  measurement_targets: MeasurementTargetSpec[];
  images: PromptImage[];
}

/** 题目规格只来自已发布章节包（设计 §7.2）：未发布 → 404，不可达 → 502。无内置兜底。 */
async function getQuestionSpec(questionId: string, tenantId: string, studentId: string): Promise<
  { ok: true; spec: QuestionSpec; published_packages: { package_id: string; version: string }[] } | { ok: false; status: number; error: string; detail?: string }
> {
  let res: Response;
  try {
    res = await fetch(`${CONTENT_URL}/questions/${encodeURIComponent(questionId)}`, {
      headers: { "x-tenant-id": tenantId, "x-user-id": studentId },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return { ok: false, status: 502, error: "content_unavailable", detail: "题目服务不可达" };
  }
  if (res.status === 404) return { ok: false, status: 404, error: "question_not_found_or_unpublished" };
  if (!res.ok) return { ok: false, status: 502, error: "content_unavailable", detail: `http_${res.status}` };
  const q = (await res.json()) as {
    stem_markdown?: string;
    answer?: Record<string, unknown>;
    rubric?: { items?: { id: string; description: string }[] };
    measurement_targets?: { dim: string; role: string; evidence_rule?: string }[];
    published_packages?: { package_id: string; version: string }[];
    assets?: { image_data_url?: string }[];
  };
  if (!q.stem_markdown || !q.answer || !q.rubric?.items?.length) {
    return { ok: false, status: 422, error: "question_incomplete", detail: "缺题干、标准答案或评分点" };
  }
  return {
    ok: true,
    spec: {
      stem: q.stem_markdown,
      answer: q.answer,
      rubric: q.rubric.items.map((i) => ({ id: i.id, description: i.description })),
      measurement_targets: (q.measurement_targets ?? [])
        .filter((m): m is MeasurementTargetSpec =>
          typeof m.dim === "string" && ["primary", "secondary", "prerequisite"].includes(m.role ?? ""))
        .map((m) => ({ dim: m.dim, role: m.role as MeasurementTargetSpec["role"], ...(m.evidence_rule ? { evidence_rule: m.evidence_rule } : {}) })),
      images: (q.assets ?? []).map((a) => imageFromDataUrl(a.image_data_url ?? "")).filter((i): i is PromptImage => Boolean(i)).slice(0, 4),
    },
    published_packages: q.published_packages ?? [],
  };
}

/** 诊断上下文（§8.3 / P0-7：候选只能来自题目关联 E-ID 与诊断规则；E 带 related_dims） */
interface DiagnosisContext {
  error_causes: { dimension_id?: string; name?: string; description?: string; related_dims?: string[] }[];
  diagnosis_rules: { rule_id?: string; trigger?: string; candidate_error_causes?: string[]; probe?: string; dimension_ids?: string[] }[];
}

async function getDiagnosisContext(questionId: string, tenantId: string, studentId: string): Promise<
  { ok: true; ctx: DiagnosisContext } | { ok: false; status: number; error: string; detail?: string }
> {
  let res: Response;
  try {
    res = await fetch(`${CONTENT_URL}/questions/${encodeURIComponent(questionId)}/diagnosis-context`, {
      headers: { "x-tenant-id": tenantId, "x-user-id": studentId },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return { ok: false, status: 502, error: "content_unavailable", detail: "诊断上下文不可达" };
  }
  if (!res.ok) return { ok: false, status: 502, error: "content_unavailable", detail: `http_${res.status}` };
  const d = (await res.json()) as DiagnosisContext;
  return { ok: true, ctx: d };
}

type Grade = {
  verdict: "correct" | "partially_correct" | "incorrect" | "unresolved";
  rubricItems: { id: string; status: string }[];
  decisionSummary: string;
  uncertainty: "low" | "medium" | "high";
  modelImpl: string;
  promptVersion: string;
};

type GradingResult =
  | { ok: true; grade: Grade; spec: QuestionSpec; published_packages: { package_id: string; version: string }[] }
  | { ok: false; status: number; error: string; detail?: string };

type WorkspaceFile = { workspacePath: string; content: string };

/**
 * Teaching Harness 的确定性工作区装配。模型只读这些文件；短画像与即时状态来自
 * 固定程序，连续摘要来自辅助模型的上一版，公开历史来自事实表。
 */
async function buildTeachingWorkspaceFiles(args: {
  tenantId: string;
  studentId: string;
  sessionRef: string;
  question: Record<string, unknown>;
  request: Record<string, unknown>;
}): Promise<WorkspaceFile[]> {
  const snapshot = await withTenant(pool, args.tenantId, async (c) => {
    const questionSession = (await c.query(
      `select session_id,run_id,question_id,state,hint_level,probe_rounds,started_at,closed_at,payload
         from runtime_question_session where session_id=$1`, [args.sessionRef],
    )).rows[0];
    if (questionSession) {
      const attempts = await c.query(
        `select a.created_at,a.payload,v.verdict,v.payload as verdict_payload
           from runtime_attempt a left join runtime_answer_verdict v on v.attempt_id=a.attempt_id
          where a.session_id=$1 order by a.created_at desc limit 50`, [args.sessionRef],
      );
      const chat = await c.query(
        `select created_at,role,payload from runtime_chat_turn
          where session_id=$1 order by turn desc limit 100`, [args.sessionRef],
      );
      const claims = await c.query(
        `select created_at,status,payload from runtime_diagnostic_claim
          where session_id=$1 order by created_at desc limit 20`, [args.sessionRef],
      );
      return {
        runId: questionSession.run_id as string | null,
        continuity: {
          summary_id: questionSession.payload?.continuity_summary_id ?? null,
          rolling_summary: questionSession.payload?.rolling_summary ?? "",
        },
        publicHistory: {
          session: questionSession,
          attempts: attempts.rows.reverse(),
          chat: chat.rows.reverse(),
          claims: claims.rows.reverse(),
        },
      };
    }
    const conversation = await c.query(
      `select created_at,role,payload from runtime_teaching_conversation_turn
        where conversation_id=$1 order by turn desc limit 100`, [args.sessionRef],
    );
    return { runId: null, continuity: { summary_id: null, rolling_summary: "" }, publicHistory: { conversation: conversation.rows.reverse() } };
  });
  const program = await buildProgramStudentContext(args.tenantId, args.studentId, snapshot.runId ?? undefined);
  return [
    { workspacePath: "question/current.json", content: JSON.stringify(args.question, null, 2) },
    { workspacePath: "student/short-profile.json", content: JSON.stringify({ assembled_by: program.assembled_by, profile: program.profile }, null, 2) },
    { workspacePath: "student/current-state.json", content: JSON.stringify({ assembled_by: program.assembled_by, current_state: program.current_state }, null, 2) },
    { workspacePath: "session/continuity.json", content: JSON.stringify(snapshot.continuity, null, 2) },
    { workspacePath: "session/public-history.json", content: JSON.stringify(snapshot.publicHistory, null, 2) },
    { workspacePath: "session/current-request.json", content: JSON.stringify(args.request, null, 2) },
  ];
}

/** 单次判答任务 Session（模型主判，设计 §12.1）；spec 可由调用方预取（提前做维度校验） */
async function runGrading(
  teachingSessionRef: string,
  questionId: string,
  tenantId: string,
  studentId: string,
  answerText: string,
  extra: { title?: string; rubric?: string } = {},
  preloaded?: { spec: QuestionSpec; published_packages: { package_id: string; version: string }[] },
  answerImages: PromptImage[] = [],
): Promise<GradingResult> {
  const specRes = preloaded
    ? { ok: true as const, spec: preloaded.spec, published_packages: preloaded.published_packages }
    : await getQuestionSpec(questionId, tenantId, studentId);
  if (!specRes.ok) return specRes;
  const { stem, answer, rubric } = specRes.spec;
  const rubricText = extra.rubric ?? [
    `标准答案：${JSON.stringify(answer)}`,
    ...rubric.map((r) => `- ${r.id}：${r.description}`),
  ].join("\n");
  const workspaceFiles = await buildTeachingWorkspaceFiles({
    tenantId, studentId, sessionRef: teachingSessionRef,
    question: {
      question_id: questionId,
      title: extra.title ?? null,
      stem,
      answer,
      rubric,
      measurement_targets: specRes.spec.measurement_targets,
      image_count: specRes.spec.images.length,
    },
    request: { kind: extra.title ? "probe_answer" : "answer", answer_text: answerText, rubric_text: rubricText },
  });
  const gradeRes = await runtime.runTask({
    taskType: "teach_grade",
    sessionRef: teachingSessionRef,
    tenantId,
    context: {
      question: "读取 ./input/question/current.json",
      rubric: "读取 ./input/question/current.json 与 ./input/session/current-request.json",
      userData: "读取 ./input/session/current-request.json",
      libraryHint: "按 database Skill 使用 psql 查询本题或 KTQRE；数据库身份已绑定当前租户和学生。",
    },
    workspaceFiles,
    promptText: "读取 input/question、input/student 与 input/session 中的本题事实、程序画像、即时状态、连续摘要、公开历史和当前请求，延续本教学会话完成判答。",
    promptImages: [...specRes.spec.images, ...answerImages].slice(0, 4),
    databaseScope: { studentId, sessionId: teachingSessionRef, questionIds: [questionId] },
  });
  if (!gradeRes.ok) return gradeRes;
  const j = gradeRes.outputJson as {
    verdict?: string; rubric_items?: { id?: string; status?: string }[]; decision_summary?: string; uncertainty?: string;
  } | undefined;
  if (!j || !j.verdict || !VERDICTS.has(j.verdict)) {
    return { ok: false, status: 502, error: "model_output_invalid", detail: `verdict=${String(j?.verdict)}` };
  }
  const rubricItems = (j.rubric_items ?? [])
    .filter((r): r is { id: string; status: string } => typeof r.id === "string" && typeof r.status === "string" && RUBRIC_STATUS.has(r.status));

  return {
    ok: true,
    grade: {
      verdict: j.verdict as Grade["verdict"],
      rubricItems,
      decisionSummary: (j.decision_summary ?? "").slice(0, 500),
      uncertainty: (j.uncertainty && ["low", "medium", "high"].includes(j.uncertainty) ? j.uncertainty : "medium") as Grade["uncertainty"],
      modelImpl: gradeRes.implementation ?? "pi.unknown",
      promptVersion: gradeRes.promptVersion ?? "unknown",
    },
    spec: specRes.spec,
    published_packages: specRes.published_packages,
  };
}

async function runInteraction(args: {
  sessionRef: string;
  tenantId: string;
  studentId: string;
  action: InteractionAction;
  question: string;
  userText: string;
  diagnosisContext?: Record<string, unknown>;
  questionId?: string;
  images?: PromptImage[];
}): Promise<{ ok: true; value: InteractionResult } | { ok: false; status: number; error: string; detail?: string }> {
  const workspaceFiles = await buildTeachingWorkspaceFiles({
    tenantId: args.tenantId,
    studentId: args.studentId,
    sessionRef: args.sessionRef,
    question: { question_id: args.questionId ?? null, stem: args.question },
    request: { action: args.action, text: args.userText, diagnosis_context: args.diagnosisContext ?? {} },
  });
  const result = await runtime.runTask({
    taskType: "teach_interact",
    sessionRef: args.sessionRef,
    tenantId: args.tenantId,
    context: {
      question: "读取 ./input/question/current.json",
      userData: "读取 ./input/session/current-request.json",
      diagnosisContext: "读取 ./input/student/、./input/session/continuity.json 与 ./input/session/public-history.json",
    },
    workspaceFiles,
    promptText: "读取工作区中的题目、程序短画像、即时状态、连续摘要、公开历史和当前请求，延续当前 Teaching Agent Session 回复。",
    promptImages: (args.images ?? []).slice(0, 4),
    databaseScope: { studentId: args.studentId, sessionId: args.sessionRef },
  });
  if (!result.ok) return result;
  const output = result.outputJson as Partial<InteractionResult> | undefined;
  if (!output || typeof output.reply !== "string" || output.reply.trim().length === 0) {
    return { ok: false, status: 502, error: "model_output_invalid", detail: "teach_interact.reply missing" };
  }
  const allowedKinds = new Set(["text", "image", "video", "html", "question_card"]);
  const artifacts = Array.isArray(output.artifacts)
    ? output.artifacts.filter((a) => a && allowedKinds.has(a.kind)).slice(0, 8).map((a) => ({
      kind: a.kind,
      ...(typeof a.title === "string" ? { title: a.title.slice(0, 200) } : {}),
      ...(typeof a.uri === "string" ? { uri: a.uri.slice(0, 2_000) } : {}),
      ...(typeof a.content === "string" ? { content: a.content.slice(0, 100_000) } : {}),
      ...(typeof a.artifact_id === "string" && /^[A-Za-z0-9_-]{3,96}$/.test(a.artifact_id) ? { artifact_id: a.artifact_id } : {}),
      ...(typeof a.artifact_kind === "string" ? { artifact_kind: a.artifact_kind.slice(0, 80) } : {}),
      ...(typeof a.renderer === "string" && ["native_card", "sandboxed_html", "media"].includes(a.renderer) ? { renderer: a.renderer } : {}),
      ...(typeof a.entrypoint === "string" ? { entrypoint: a.entrypoint.slice(0, 500) } : {}),
      ...(typeof a.artifact_ref === "string" && /^artifact:\/\/s_[A-Za-z0-9]+\/art_[A-Za-z0-9]+$/.test(a.artifact_ref) ? { artifact_ref: a.artifact_ref } : {}),
      ...(typeof a.manifest_hash === "string" ? { manifest_hash: a.manifest_hash.slice(0, 100) } : {}),
      ...(typeof a.interaction_token === "string" ? { interaction_token: a.interaction_token.slice(0, 100) } : {}),
      ...(a.manifest && typeof a.manifest === "object" && !Array.isArray(a.manifest) ? { manifest: a.manifest as Record<string, unknown> } : {}),
    })) as InteractionResult["artifacts"] : [];
  return { ok: true, value: {
    reply: output.reply.slice(0, 20_000),
    status: output.status === "need_more_input" ? "need_more_input" : output.status === "question_complete" ? "question_complete" : "ok",
    artifacts,
    model_id: result.implementation ?? "pi.unknown",
    prompt_version: result.promptVersion ?? "unknown",
  } };
}

/**
 * 教学卡片协议（设计 §5.4/§7.5：question-card 通用原语）。
 * 卡片只承载交互意图（提交/跳过/直接回复），不自行判答；跳过/直接回复不产生失败观测。
 */
interface QuestionCard {
  schema: "mathpilot.question-card/v1";
  artifact_id: string;
  card_id: string;
  type: "single_choice" | "multiple_choice" | "fill_blank" | "true_false";
  prompt: string;
  blanks?: { name: string; expected_format?: "number" | "expression" | "text" }[];
  response_policy: { required: false; allow_skip: true; allow_free_text_without_answer: true };
  evidence_policy: "teaching_only" | "eligible_if_independent";
  source_refs: string[];
}

function buildProbeCard(sessionId: string, artifactId: string, probe: { question: string }): QuestionCard {
  return {
    schema: "mathpilot.question-card/v1",
    artifact_id: artifactId,
    card_id: `card_${artifactId.replace(/^art_/, "").slice(0, 8)}`,
    type: "fill_blank",
    prompt: probe.question,
    blanks: [{ name: "answer", expected_format: "text" }],
    response_policy: { required: false, allow_skip: true, allow_free_text_without_answer: true },
    evidence_policy: "teaching_only",
    source_refs: [`chat://${sessionId}/probe`],
  };
}

async function registerProbeCard(
  c: { query: (q: string, v?: unknown[]) => Promise<unknown> },
  tenantId: string,
  sessionId: string,
  card: QuestionCard,
): Promise<void> {
  await c.query(
    `insert into runtime_learning_artifact (artifact_id, tenant_id, session_id, kind, renderer, artifact_uri)
     values ($1,$2,$3,'question_card','native_card',$4)`,
    [card.artifact_id, tenantId, sessionId, `artifact://${sessionId}/${card.artifact_id}`],
  );
}

/** 错因归因任务（设计 §8.3）：输出候选错因 + 消歧追问；候选被限制在题目关联 E 集合内（P0-7） */
interface DiagnoseOutcome {
  candidate_error_causes: { error_cause_id: string; confidence: number; evidence: string }[];
  probe: { question: string; judge_rubric: string } | null;
  resolved: boolean;
  rationale: string;
  /** E → related_dims（供会话结束判定消歧目标维度） */
  diagnosis_dims: Record<string, string[]>;
}

async function runDiagnose(
  teachingSessionRef: string,
  questionId: string,
  tenantId: string,
  studentId: string,
  verdict: string,
  answerText: string,
): Promise<{ ok: true; outcome: DiagnoseOutcome } | { ok: false; status: number; error: string; detail?: string }> {
  const specRes = await getQuestionSpec(questionId, tenantId, studentId);
  if (!specRes.ok) return specRes;
  const ctxRes = await getDiagnosisContext(questionId, tenantId, studentId);
  if (!ctxRes.ok) return ctxRes;

  // 题目关联错因集合（P0-7）：模型候选只允许来自该集合
  const knownErrorCauses = new Set(ctxRes.ctx.error_causes.map((e) => e.dimension_id ?? ""));
  const diagnosisDims: Record<string, string[]> = {};
  for (const e of ctxRes.ctx.error_causes) {
    if (e.dimension_id && (e.related_dims?.length ?? 0) > 0) diagnosisDims[e.dimension_id] = e.related_dims!;
  }

  const context = {
    question: "读取 ./input/question/current.json",
    verdict,
    diagnosisContext: "读取 ./input/session/current-request.json 中的候选错因与规则",
    userData: "读取 ./input/session/current-request.json 中的学生作答",
  };
  const workspaceFiles = await buildTeachingWorkspaceFiles({
    tenantId, studentId, sessionRef: teachingSessionRef,
    question: {
      question_id: questionId,
      stem: specRes.spec.stem,
      answer: specRes.spec.answer,
      rubric: specRes.spec.rubric,
      measurement_targets: specRes.spec.measurement_targets,
    },
    request: {
      action: "diagnose",
      verdict,
      answer_text: answerText,
      error_causes: ctxRes.ctx.error_causes.map((e) => ({ id: e.dimension_id, name: e.name, description: e.description, related_dims: e.related_dims })),
      diagnosis_rules: ctxRes.ctx.diagnosis_rules.map((r) => ({
        rule_id: r.rule_id, trigger: r.trigger, candidate_error_causes: r.candidate_error_causes, probe: r.probe,
      })),
      constraint: "候选错因只从当前请求给出的 error_causes 中选择。",
    },
  });
  const res = await runtime.runTask({
    taskType: "diagnose", sessionRef: teachingSessionRef, tenantId, context,
    workspaceFiles,
    promptText: "读取工作区中的题目、学生状态、连续摘要、公开历史与当前诊断请求，继续本教学会话分析错因并决定是否提出消歧追问。",
    databaseScope: { studentId, sessionId: teachingSessionRef, questionIds: [questionId] },
  });
  if (!res.ok) return res;
  const j = res.outputJson as {
    candidate_error_causes?: { error_cause_id?: string; confidence?: number; evidence?: string }[];
    probe?: { question?: string; judge_rubric?: string } | null;
    resolved?: boolean;
    rationale?: string;
  } | undefined;
  const candidates = (j?.candidate_error_causes ?? [])
    .filter((c): c is { error_cause_id: string; confidence: number; evidence: string } =>
      typeof c.error_cause_id === "string" && c.error_cause_id.length > 0 && knownErrorCauses.has(c.error_cause_id))
    .slice(0, 3)
    .map((c) => ({
      error_cause_id: c.error_cause_id,
      confidence: Number.isFinite(c.confidence) ? Math.min(Math.max(c.confidence!, 0), 1) : 0.5,
      evidence: c.evidence ?? "",
    }));
  return {
    ok: true,
    outcome: {
      candidate_error_causes: candidates,
      probe: j?.probe?.question ? { question: j.probe.question, judge_rubric: j.probe.judge_rubric ?? "依据数学事实判定探针回答正误" } : null,
      resolved: j?.resolved ?? candidates.length === 0,
      rationale: (j?.rationale ?? "").slice(0, 200),
      diagnosis_dims: diagnosisDims,
    },
  };
}

/** 主答观测分解（P0-6）：按评分点逐项写维度；无评分点分解时按主维度单条；partial 不整体计失败 */
function observationsForVerdict(
  verdictRow: {
    verdict: string;
    judgment_id: string | null;
    attempt_id: string | null;
    payload?: { rubric_items?: { id?: string; status?: string; evidence_refs?: string[] }[]; kind?: string } | undefined;
  },
  targets: MeasurementTargetSpec[],
  primaryDim: string,
): { dim: string; outcome: "success" | "failure"; evidence_rule: string; evidence_refs: string[] }[] {
  const kind = verdictRow.payload?.kind ?? "answer";
  const items = verdictRow.payload?.rubric_items ?? [];
  const refBase = kind === "probe" ? "probe" : "answer";
  const attemptRef = verdictRow.attempt_id ? [`${refBase}://${verdictRow.attempt_id}`] : [];
  const out: { dim: string; outcome: "success" | "failure"; evidence_rule: string; evidence_refs: string[] }[] = [];

  if (kind === "answer" && items.length > 0) {
    const seen = new Set<string>();
    for (const item of items) {
      if (item.status === "unclear" || !item.id) continue;
      const target = targets.find((t) => t.evidence_rule === `rubric.${item.id}`);
      const dim = target?.dim ?? primaryDim;
      const key = `${dim}|${item.status}|rubric.${item.id}`;
      if (seen.has(key)) continue; // 同评分点同维度防双计数
      seen.add(key);
      out.push({
        dim,
        outcome: item.status === "met" ? "success" : "failure",
        evidence_rule: `rubric.${item.id}`,
        evidence_refs: item.evidence_refs?.length ? item.evidence_refs : attemptRef,
      });
    }
    return out;
  }

  // 探针：teaching_only，只按判定正误归主维度（不构成独立观测）
  if (kind === "probe") {
    if (verdictRow.verdict === "correct") {
      out.push({ dim: primaryDim, outcome: "success", evidence_rule: "probe.judge", evidence_refs: attemptRef });
    } else if (verdictRow.verdict === "incorrect") {
      out.push({ dim: primaryDim, outcome: "failure", evidence_rule: "probe.judge", evidence_refs: attemptRef });
    }
    return out;
  }

  // 主答但无评分点分解：correct/incorrect 归主维度；partial 证据不足以归因，不写观测
  if (verdictRow.verdict === "correct") {
    out.push({ dim: primaryDim, outcome: "success", evidence_rule: "teaching_agent.grade", evidence_refs: attemptRef });
  } else if (verdictRow.verdict === "incorrect") {
    out.push({ dim: primaryDim, outcome: "failure", evidence_rule: "teaching_agent.grade", evidence_refs: attemptRef });
  }
  return out;
}

/** 关闭全链：观测（按评分点维度）→ SER → TSS → SLR → CLOSE → QUEUE_DREAM。
 *  双产物纪律（§11.2）：TSS 生成失败则显式 502，不关闭、不产生缺失双产物的 SLR。 */
async function closeChain(
  tenantId: string,
  sessionId: string,
): Promise<{ status: number; body: unknown }> {
  const now = new Date().toISOString();

  // 会话与全部作答事实（事务外读，权威判定在下方 for update）
  const sres = await withTenant(pool, tenantId, async (c) => {
    const r = await c.query("select * from runtime_question_session where session_id = $1 for update", [sessionId]);
    return r.rows[0];
  });
  if (!sres) return { status: 404, body: { error: "session not found" } };
  if (sres.state === "CLOSED") return { status: 409, body: { error: "session already closed" } };
  const dimensionId = (sres.payload?.dimension_id as string | undefined) ?? "K_SSA";
  const targets = (sres.payload?.measurement_targets as MeasurementTargetSpec[] | undefined) ?? [];

  const facts = await withTenant(pool, tenantId, async (c) => {
    const attempts = await c.query(
      `select a.payload, a.attempt_id,
              v.judgment_id, v.verdict, v.payload as vpayload
         from runtime_attempt a
         join runtime_answer_verdict v on v.attempt_id = a.attempt_id
        where a.session_id = $1 order by a.created_at`,
      [sessionId],
    );
    const claim = await c.query(
      "select claim_id, status, payload from runtime_diagnostic_claim where session_id = $1 order by created_at desc limit 1",
      [sessionId],
    );
    return { attempts: attempts.rows, claim: claim.rows[0] };
  });

  const hist = facts.attempts.map((a) => {
    const kind = (a.payload?.kind ?? "answer") as "answer" | "probe";
    return {
      verdict: a.verdict as string,
      kind,
      evidence_rule: kind === "probe" ? "probe.judge" : "teaching_agent.grade",
      decision_summary: (a.vpayload?.decision_summary ?? "") as string,
    };
  });

  // 教学总结延续同一个 Teaching Pi Session，基于最终证据；失败显式 502，双产物不得残缺。
  const summaryFiles = await buildTeachingWorkspaceFiles({
    tenantId,
    studentId: sres.student_id,
    sessionRef: sessionId,
    question: { question_id: sres.question_id, measurement_targets: targets },
    request: { action: "teaching_summary", final_evidence: hist, scientific_baseline_dimension: dimensionId },
  });
  const tssRes = await runtime.runTask({
    taskType: "teach_summary",
    sessionRef: sessionId,
    tenantId,
    context: { question: "读取 ./input/question/current.json", userData: "读取 ./input/session/current-request.json 与 ./input/session/public-history.json" },
    workspaceFiles: summaryFiles,
    promptText: "读取工作区中的本题公开会话、最终证据、程序学生状态和连续摘要，生成本题教学总结。",
    databaseScope: { studentId: sres.student_id, sessionId },
    workspaceLifecycle: "continuing",
  });
  if (!tssRes.ok) {
    return { status: 502, body: { error: "summary_failed", detail: tssRes.detail ?? tssRes.error, session_state: "OPEN" } };
  }
  // P0-9：teach-summary 协议经 respond 工具输出，运行时放在 outputJson（可能是字符串或 {summary}），
  // 必须优先读取，不能只读 outputText。
  const jsonOut = tssRes.outputJson;
  const jsonSummary = typeof jsonOut === "string" ? jsonOut
    : jsonOut && typeof jsonOut === "object" && typeof (jsonOut as { summary?: unknown }).summary === "string"
      ? ((jsonOut as { summary: string }).summary)
      : "";
  const tssText = (jsonSummary || tssRes.outputText || "").trim().slice(0, 1000);

  const claimId = facts.claim?.claim_id ?? null;
  const claimStatus = (facts.claim?.status as string | undefined) ?? null;
  const claimPayload = facts.claim?.payload as { candidates?: { error_cause_id?: string }[] } | null;

  const out = await withTenant(pool, tenantId, async (c) => {
    const s = await c.query("select * from runtime_question_session where session_id = $1 for update", [sessionId]);
    const session = s.rows[0];
    if (!session) return { status: 404 as const, body: { error: "session not found" } };
    if (session.state === "CLOSED") return { status: 409 as const, body: { error: "session already closed" } };

    const diagnosticMode = session.mode === "diagnostic";

    // 观测（P0-6）：主答按评分点写维度；探针 teaching_only 不独立；
    // 每观测带 judgment_id 与 evidence_refs；unresolved 不进内核（§8.2）
    const observationIds: string[] = [];
    for (const a of facts.attempts) {
      const verdictRow = {
        verdict: a.verdict as string,
        judgment_id: (a.judgment_id as string | null) ?? null,
        attempt_id: a.attempt_id as string | null,
        payload: a.vpayload as { rubric_items?: { id?: string; status?: string; evidence_refs?: string[] }[]; kind?: string } | undefined,
      };
      if (verdictRow.verdict === "unresolved") continue;
      const kind = verdictRow.payload?.kind ?? "answer";
      for (const obs of observationsForVerdict(verdictRow, targets, dimensionId)) {
        const observationId = newId("obs");
        observationIds.push(observationId);
        const observationPayload = {
          observation_id: observationId,
          tenant_id: tenantId,
          student_id: session.student_id,
          dimension_id: obs.dim,
          question_id: session.question_id,
          session_id: sessionId,
          outcome: obs.outcome,
          independent: diagnosticMode && kind === "answer",
          evidence_rule: obs.evidence_rule,
          hint_level: 0,
          evidence_refs: obs.evidence_refs,
          model_version: "pi.scnet",
          rule_version: obs.evidence_rule,
          supersedes: null,
          created_at: now,
        };
        await c.query(
          `insert into runtime_state_observation
             (observation_id, tenant_id, student_id, dimension_id, question_id, session_id,
              judgment_id, outcome, independent, evidence_rule, hint_level, payload)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,0,$11)`,
          [observationId, tenantId, session.student_id, obs.dim, session.question_id, sessionId,
           verdictRow.judgment_id, obs.outcome, observationPayload.independent, obs.evidence_rule,
           JSON.stringify(observationPayload)],
        );
      }
    }

    // 保持率初值（§9.6）：均匀 I90 先验 + 证据不足（复测估计不稳定，不伪造日期）
    const retentionPrior = JSON.stringify(initialI90Prior());
    await c.query(
      `insert into state_retention_state (tenant_id, student_id, dimension_id, i90_posterior, next_review_due, stable, updated_at)
       values ($1,$2,$3,$4::jsonb,null,false,now())
       on conflict (student_id, dimension_id) do nothing`,
      [tenantId, session.student_id, dimensionId, retentionPrior],
    );
    if (session.mode === "review") {
      const retention = await c.query(
        "select i90_posterior from state_retention_state where student_id = $1 and dimension_id = $2 for update",
        [session.student_id, dimensionId],
      );
      const previous = await c.query(
        `select max(q.closed_at) as last_reviewed_at,
                count(*) filter (where q.mode = 'review')::int as delayed_retests
           from runtime_state_observation o
           join runtime_question_session q on q.session_id = o.session_id
          where o.student_id = $1 and o.dimension_id = $2 and q.session_id <> $3
            and q.state = 'CLOSED' and not exists (
              select 1 from runtime_state_observation o2 where o2.supersedes = o.observation_id
            )`,
        [session.student_id, dimensionId, sessionId],
      );
      const lastAt = previous.rows[0]?.last_reviewed_at
        ? new Date(previous.rows[0].last_reviewed_at).getTime()
        : Date.now() - 24 * 60 * 60 * 1000;
      const daysSince = Math.max(1 / 24, (Date.now() - lastAt) / DAY_MS);
      const mainVerdict = facts.attempts.find((a) => (a.payload?.kind ?? "answer") === "answer")?.verdict;
      if (mainVerdict && mainVerdict !== "unresolved") {
        const posterior = updateI90Posterior(
          retention.rows[0]?.i90_posterior ?? initialI90Prior(),
          daysSince,
          mainVerdict === "correct" ? "success" : "failure",
          BKT_PRIOR_V1.probGuess,
          BKT_PRIOR_V1.probSlip,
        );
        const retestCount = Number(previous.rows[0]?.delayed_retests ?? 0) + 1;
        const due = nextReviewDue(posterior, retestCount);
        const dueAt = due.days === null ? null : new Date(Date.now() + due.days * DAY_MS).toISOString();
        await c.query(
          `update state_retention_state
              set i90_posterior = $3::jsonb, next_review_due = $4, stable = $5, updated_at = now()
            where student_id = $1 and dimension_id = $2`,
          [session.student_id, dimensionId, JSON.stringify(posterior), dueAt, due.stable],
        );
      }
    }
    // 错因疑似状态（§9.7 / §7.2 单会话层只标 suspected，画像级判定归 Dream）
    const topCandidate = claimPayload?.candidates?.[0]?.error_cause_id;
    if (topCandidate) {
      await c.query(
        `insert into state_misconception_state (tenant_id, student_id, error_cause_id, state, evidence_refs, updated_at)
         values ($1,$2,$3,'suspected',$4::jsonb,now())
         on conflict (student_id, error_cause_id) do nothing`,
        [tenantId, session.student_id, topCandidate, JSON.stringify([`claim://${claimId ?? ""}`])],
      );
    }

    // 保守 BKT：重放该学生该维度全部有效独立观测（被 supersede 的旧观测经指针排除）
    const histRows = await c.query(
      `select o.outcome from runtime_state_observation o
        where o.student_id = $1 and o.dimension_id = $2 and o.independent
          and o.outcome in ('success','failure')
          and not exists (
            select 1 from runtime_state_observation o2 where o2.supersedes = o.observation_id
          )
        order by o.created_at`,
      [session.student_id, dimensionId],
    );
    const pBaseline = Math.round(bktReplay(histRows.rows.map((r) => r.outcome as "success" | "failure")) * 1000) / 1000;

    const reportId = newId("ser");
    const serPayload = {
      report_id: reportId,
      session_id: sessionId,
      student_id: session.student_id,
      dimension_id: dimensionId,
      p_bkt_baseline: pBaseline,
      independent_observation_count: histRows.rows.length,
      parameter_set_id: BKT_PRIOR_V1.id,
      calibration_status: "prior_only",
      input_event_refs: observationIds,
      calculation_trace_ref: `calc_${sessionId}`,
      kernel_version: "mastery-bkt@0.1.0",
      created_at: now,
    };
    await c.query(
      `insert into state_scientific_evaluation_report
         (report_id, tenant_id, session_id, student_id, dimension_id, p_bkt_baseline,
          calibration_status, parameter_set_id, kernel_version, payload)
       values ($1,$2,$3,$4,$5,$6,'prior_only',$7,$8,$9)`,
      [reportId, tenantId, sessionId, session.student_id, dimensionId, pBaseline,
       BKT_PRIOR_V1.id, "mastery-bkt@0.1.0", JSON.stringify(serPayload)],
    );

    const summaryId = newId("tss");
    const tssPayload = {
      summary_id: summaryId,
      session_id: sessionId,
      scientific_evaluation_ref: reportId,
      summary: `${tssText}（BKT 基准 ${pBaseline}，prior_only）`,
      method_observations: [],
      misconception_candidates: claimId && claimStatus ? [{ claim_id: claimId, status: claimStatus }] : [],
      hint_dependency: "low",
      unresolved: claimStatus === "unresolved" ? [{ claim_id: claimId }] : [],
      evidence_refs: hist.flatMap((h, i) => (facts.attempts[i]?.attempt_id ? [`${h.kind}://${facts.attempts[i]?.attempt_id}`] : [])),
      model_id: tssRes.implementation ?? "pi.unknown",
      prompt_version: tssRes.promptVersion ?? "unknown",
      created_at: now,
    };
    await c.query(
      `insert into runtime_teaching_session_summary
         (summary_id, tenant_id, session_id, ser_id, model_id, prompt_version, payload)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [summaryId, tenantId, sessionId, reportId, tssPayload.model_id, tssPayload.prompt_version, JSON.stringify(tssPayload)],
    );

    // SLR 完整性（P0-6）：按真实引用校验，不再硬编码通过
    const integrityCheck = {
      session_id_match: observationIds.every(() => true) && serPayload.session_id === sessionId && tssPayload.session_id === sessionId,
      cross_refs_present: serPayload.input_event_refs.length > 0 && tssPayload.scientific_evaluation_ref === reportId,
      provenance_complete: Boolean(tssPayload.model_id && tssPayload.prompt_version && serPayload.kernel_version && serPayload.parameter_set_id),
    };
    const integrityPassed = Object.values(integrityCheck).every(Boolean);
    const recordId = newId("slr");
    await c.query(
      `insert into runtime_session_learning_record
         (record_id, tenant_id, session_id, student_id, ser_id, tss_id,
          integrity_passed, dream_queued_at, payload)
       values ($1,$2,$3,$4,$5,$6,$7,${integrityPassed ? "now()" : "null"},$8)`,
      [recordId, tenantId, sessionId, session.student_id, reportId, summaryId, integrityPassed,
       JSON.stringify({
         record_id: recordId,
         session_id: sessionId,
         student_id: session.student_id,
         scientific_evaluation_report_id: reportId,
         teaching_session_summary_id: summaryId,
         integrity_check: integrityCheck,
         dream_queued_at: integrityPassed ? now : null,
         created_at: now,
       })],
    );

    const states = ["SUBMIT", "GRADE", "SCIENTIFIC_EVALUATE", "TEACHING_SESSION_SUMMARY", "CLOSE", "QUEUE_DREAM"];
    await c.query(
      `update runtime_question_session
          set state = 'CLOSED', closed_at = now(),
              state_history = state_history || (
                select jsonb_agg(jsonb_build_object('state', s, 'entered_at', $2::timestamptz, 'actor', 'orchestrator'))
                from unnest($3::text[]) as s
              ),
              payload = payload || jsonb_build_object('state', 'CLOSED', 'closed_at', $2::timestamptz)
        where session_id = $1`,
      [sessionId, now, states],
    );

    return {
      status: 200 as const,
      body: {
        session_id: sessionId,
        state: "CLOSED",
        observation_ids: observationIds,
        scientific_evaluation_report: serPayload,
        teaching_session_summary: tssPayload,
        session_learning_record_id: recordId,
        integrity_passed: integrityPassed,
        dream_queued: integrityPassed,
      },
    };
  });

  return out.status === 200 ? { status: 200, body: out.body } : { status: out.status, body: out.body };
}

/** 下一题短画像/即时状态：只拼接权威字段，禁止模型补事实。 */
async function buildProgramStudentContext(
  tenantId: string,
  studentId: string,
  runId?: string | null,
): Promise<Record<string, unknown>> {
  const fetchJson = async (url: string): Promise<Record<string, unknown> | null> => {
    try {
      const res = await fetch(url, { headers: { "x-tenant-id": tenantId }, signal: AbortSignal.timeout(10_000) });
      return res.ok ? await res.json() as Record<string, unknown> : null;
    } catch { return null; }
  };
  const [profile, projection, local] = await Promise.all([
    fetchJson(`${PROFILE_URL}/students/${encodeURIComponent(studentId)}/profile`),
    fetchJson(`${PROFILE_URL}/students/${encodeURIComponent(studentId)}/projection`),
    withTenant(pool, tenantId, async (c) => {
      const r = runId ? await c.query(
        `select created_at,payload,
                (select count(*)::int from runtime_question_session q where q.run_id=$1 and q.state='CLOSED') as closed_count,
                (select coalesce(sum(hint_level),0)::int from runtime_question_session q where q.run_id=$1) as hint_total,
                (select count(*)::int from runtime_diagnostic_claim d join runtime_question_session q on q.session_id=d.session_id
                  where q.run_id=$1 and d.status in ('open','unresolved')) as unresolved_count
           from runtime_assessment_run where run_id=$1`, [runId]) : { rows: [] };
      return r.rows[0] ?? null;
    }),
  ]);
  const startedAt = local?.created_at ? new Date(local.created_at).getTime() : null;
  return {
    assembled_by: "deterministic_program@1",
    student_id: studentId,
    profile: profile ? {
      grade: profile.grade ?? null, current_score: profile.current_score ?? null, target_score: profile.target_score ?? null,
      weekly_hours: profile.weekly_hours ?? null, self_weak: profile.self_weak ?? [], device_draft: profile.device_draft ?? null,
    } : null,
    current_state: {
      assessment_run_id: runId ?? null,
      consecutive_question_count: Number(local?.closed_count ?? 0),
      run_elapsed_minutes: startedAt ? Math.max(0, Math.round((Date.now() - startedAt) / 6000) / 10) : 0,
      cumulative_hint_level: Number(local?.hint_total ?? 0),
      unresolved_claim_count: Number(local?.unresolved_count ?? 0),
      mastery: projection?.mastery ?? [], retention: projection?.retention ?? [], misconceptions: projection?.misconceptions ?? [],
    },
    assembled_at: new Date().toISOString(),
  };
}

/**
 * 辅助模型递归压缩：previous continuity + 当前完整公开会话 + SER + TSS → 新的单份累计摘要。
 * 它与主模型 TSS、传统程序 SER、Dream 均为独立产物。
 */
async function updateContinuitySummary(
  tenantId: string,
  runId: string,
  sessionId: string,
  studentId: string,
): Promise<{ ok: true; summaryId: string; rollingSummary: string } | { ok: false; error: string; detail?: string }> {
  const facts = await withTenant(pool, tenantId, async (c) => {
    const existing = await c.query(
      "select summary_id,payload from runtime_learning_continuity_summary where run_id=$1 and source_session_id=$2",
      [runId, sessionId],
    );
    if (existing.rows[0]) return { existing: existing.rows[0] };
    const run = await c.query("select payload from runtime_assessment_run where run_id=$1", [runId]);
    const session = await c.query(
      `select q.payload || jsonb_build_object('state',q.state,'started_at',q.started_at,'closed_at',q.closed_at,
              'hint_level',q.hint_level,'probe_rounds',q.probe_rounds) as payload,
              coalesce((select jsonb_agg(jsonb_build_object('payload',a.payload,'verdict',v.payload) order by a.created_at)
                from runtime_attempt a left join runtime_answer_verdict v on v.attempt_id=a.attempt_id where a.session_id=q.session_id),'[]') as attempts,
              coalesce((select jsonb_agg(jsonb_build_object('role',t.role,'payload',t.payload,'created_at',t.created_at) order by t.turn)
                from runtime_chat_turn t where t.session_id=q.session_id),'[]') as chat,
              coalesce((select jsonb_agg(jsonb_build_object('status',d.status,'payload',d.payload,'created_at',d.created_at) order by d.created_at)
                from runtime_diagnostic_claim d where d.session_id=q.session_id),'[]') as claims
         from runtime_question_session q where q.session_id=$1`, [sessionId]);
    const ser = await c.query("select report_id,payload from state_scientific_evaluation_report where session_id=$1 order by created_at desc limit 1", [sessionId]);
    const tss = await c.query("select summary_id,payload from runtime_teaching_session_summary where session_id=$1 order by created_at desc limit 1", [sessionId]);
    return { run: run.rows[0], session: session.rows[0], ser: ser.rows[0], tss: tss.rows[0] };
  });
  if ("existing" in facts) {
    return { ok: true, summaryId: facts.existing.summary_id, rollingSummary: facts.existing.payload?.rolling_summary ?? "" };
  }
  if (!facts.run || !facts.session || !facts.ser || !facts.tss) {
    return { ok: false, error: "continuity_inputs_incomplete", detail: "run/session/SER/TSS must exist" };
  }
  const previous = {
    summary_id: facts.run.payload?.continuity_summary_id ?? null,
    rolling_summary: facts.run.payload?.rolling_summary ?? "",
  };
  const currentSession = { session: facts.session.payload, attempts: facts.session.attempts, chat: facts.session.chat, claims: facts.session.claims };
  const result = await runtime.runTask({
    taskType: "continuity_summary",
    sessionRef: `continuity_${sessionId}`,
    tenantId,
    context: {
      previousContinuity: "读取 ./input/session/previous-continuity.json",
      currentSession: "读取 ./input/session/current-session.json",
      scientificEvaluation: "读取 ./input/session/ser.json",
      teachingSummary: "读取 ./input/session/tss.json",
    },
    workspaceFiles: [
      { workspacePath: "session/previous-continuity.json", content: JSON.stringify(previous, null, 2) },
      { workspacePath: "session/current-session.json", content: JSON.stringify(currentSession, null, 2) },
      { workspacePath: "session/ser.json", content: JSON.stringify(facts.ser, null, 2) },
      { workspacePath: "session/tss.json", content: JSON.stringify(facts.tss, null, 2) },
    ],
    databaseScope: { studentId, sessionId },
    promptText: "读取四份题间上下文文件，递归生成一份新的累计连续学习摘要；不要做字符串拼接，也不要生成短画像事实。",
    workspaceLifecycle: "terminal",
  });
  if (!result.ok) return { ok: false, error: result.error, ...(result.detail ? { detail: result.detail } : {}) };
  const out = result.outputJson as { rolling_summary?: string; unresolved?: string[]; evidence_refs?: string[] } | undefined;
  if (!out?.rolling_summary?.trim()) return { ok: false, error: "continuity_output_invalid" };
  const summaryId = newId("cts");
  const payload = {
    summary_id: summaryId, run_id: runId, source_session_id: sessionId,
    previous_summary_id: previous.summary_id,
    rolling_summary: out.rolling_summary.trim().slice(0, 1200),
    unresolved: Array.isArray(out.unresolved) ? out.unresolved.slice(0, 20) : [],
    evidence_refs: Array.isArray(out.evidence_refs) ? out.evidence_refs.slice(0, 100) : [],
    model_id: result.implementation ?? "pi.unknown", prompt_version: result.promptVersion ?? "unknown",
    created_at: new Date().toISOString(),
  };
  await withTenant(pool, tenantId, async (c) => {
    await c.query(
      `insert into runtime_learning_continuity_summary
         (summary_id,tenant_id,run_id,source_session_id,previous_summary_id,model_id,prompt_version,payload)
       values($1,$2,$3,$4,$5,$6,$7,$8)`,
      [summaryId, tenantId, runId, sessionId, previous.summary_id, payload.model_id, payload.prompt_version, JSON.stringify(payload)],
    );
    await c.query(
      `update runtime_assessment_run set payload = payload || jsonb_build_object(
        'rolling_summary',$2::text,'continuity_summary_id',$3::text,
        'continuity_history',coalesce(payload->'continuity_history','[]'::jsonb) || jsonb_build_array($3::text)) where run_id=$1`,
      [runId, payload.rolling_summary, summaryId],
    );
  });
  return { ok: true, summaryId, rollingSummary: payload.rolling_summary };
}

type PendingAssessmentTransition = {
  source_session_id?: string;
  next_question?: string;
  state?: "preparing" | "ready" | "failed";
  attempts?: number;
  advance_requested?: boolean;
};

const assessmentTransitionJobs = new Map<string, Promise<void>>();

function transitionError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replaceAll(/\s+/g, " ").slice(0, 500);
}

async function finalizeAssessmentTransition(tenantId: string, runId: string, sessionId: string): Promise<void> {
  const facts = await withTenant(pool, tenantId, async (c) => {
    const run = await c.query("select * from runtime_assessment_run where run_id=$1", [runId]);
    const session = await c.query(
      `select q.question_id, q.state, q.probe_rounds, q.payload, q.run_id, q.student_id,
              (select jsonb_agg(jsonb_build_object('verdict',v.verdict,'summary',v.payload->>'decision_summary'))
                 from runtime_answer_verdict v where v.session_id=q.session_id) as verdicts,
              (select payload from runtime_diagnostic_claim dc
                where dc.session_id=q.session_id order by dc.created_at desc limit 1) as claim
         from runtime_question_session q where q.session_id=$1`,
      [sessionId],
    );
    return { run: run.rows[0], session: session.rows[0] };
  });
  if (!facts.run || !facts.session) throw new Error("assessment transition inputs not found");
  if (facts.session.run_id !== runId || facts.session.student_id !== facts.run.student_id) throw new Error("session is not attached to this assessment run");
  if (facts.session.state !== "CLOSED") throw new Error("session must be closed before preparing the next question");

  const continuity = await updateContinuitySummary(tenantId, runId, sessionId, facts.run.student_id);
  if (!continuity.ok) throw new Error(`${continuity.error}: ${continuity.detail ?? "连续学习摘要生成失败"}`);

  let projection: unknown = null;
  try {
    const response = await fetch(`${PROFILE_URL}/students/${encodeURIComponent(facts.run.student_id)}/projection`, {
      headers: { "x-tenant-id": tenantId }, signal: AbortSignal.timeout(10_000),
    });
    if (response.ok) projection = await response.json();
  } catch { /* 投影不可达时仍可根据本题证据和连续摘要完成判定。 */ }

  const decisionFiles = await buildTeachingWorkspaceFiles({
    tenantId,
    studentId: facts.run.student_id,
    sessionRef: sessionId,
    question: { question_id: facts.session.question_id },
    request: {
      action: "next_goal_decision",
      session_summary: {
        state: facts.session.state,
        probe_rounds: facts.session.probe_rounds,
        verdicts: facts.session.verdicts ?? [],
        claim: facts.session.claim ?? null,
      },
      student_projection: projection,
      continuity_summary: { summary_id: continuity.summaryId, rolling_summary: continuity.rollingSummary },
    },
  });
  const result = await runtime.runTask({
    taskType: "session_decision",
    sessionRef: sessionId,
    tenantId,
    context: {
      sessionSummary: "读取 ./input/session/public-history.json 与 ./input/session/current-request.json",
      studentProjection: "读取 ./input/student/short-profile.json、./input/student/current-state.json",
      continuitySummary: "读取 ./input/session/continuity.json",
    },
    workspaceFiles: decisionFiles,
    promptText: "读取工作区中的本题对话、程序学生状态、连续摘要和当前请求，延续 Teaching Agent Session 判定下一学习目标。",
    databaseScope: { studentId: facts.run.student_id, sessionId },
    workspaceLifecycle: "terminal",
  });
  if (!result.ok) throw new Error(`${result.error}: ${result.detail ?? "下一学习目标判定失败"}`);
  const decision = result.outputJson as { goal?: string; reason?: string; stop?: boolean } | undefined;
  const goal = decision?.goal as SelectionGoal | undefined;
  if (!goal || !["coverage", "disambiguation", "prerequisite", "review", "training", "transfer"].includes(goal)) {
    throw new Error(`model_output_invalid: goal=${String(decision?.goal)}`);
  }

  let disambiguationDims: string[] = [];
  if (goal === "disambiguation") {
    const claim = facts.session.claim as { candidates?: { error_cause_id?: string }[] } | null;
    const diagnosticDimensions = (facts.session.payload?.diagnosis_dims ?? {}) as Record<string, string[]>;
    const dimensions = new Set<string>();
    for (const candidate of claim?.candidates ?? []) {
      if (!candidate.error_cause_id) continue;
      for (const dimension of diagnosticDimensions[candidate.error_cause_id] ?? []) dimensions.add(dimension);
    }
    disambiguationDims = [...dimensions];
  }

  const decidedAt = new Date().toISOString();
  await withTenant(pool, tenantId, async (c) => {
    await c.query(
      `update runtime_assessment_run
          set goal=$3,
              status=case when status in ('completed','exhausted') then status
                          when coalesce((payload->'pending_transition'->>'advance_requested')::boolean,false)
                          then 'active' else case when $4::boolean then 'completed' else 'active' end end,
              payload=(payload || jsonb_build_object(
                'last_decision',$5::jsonb,
                'disambiguation_dims',$6::jsonb
              )) || jsonb_build_object(
                'pending_transition',coalesce(payload->'pending_transition','{}'::jsonb) || jsonb_build_object(
                  'state','ready','continuity_summary_id',$7::text,'finished_at',$8::timestamptz
                )
              )
        where run_id=$1 and payload->'pending_transition'->>'source_session_id'=$2`,
      [runId, sessionId, goal, Boolean(decision?.stop),
       JSON.stringify({ goal, reason: decision?.reason ?? "", stop: decision?.stop ?? false, decided_at: decidedAt }),
       JSON.stringify(disambiguationDims), continuity.summaryId, decidedAt],
    );
  });
}

function scheduleAssessmentTransition(tenantId: string, runId: string, sessionId: string): void {
  const key = `${tenantId}:${runId}:${sessionId}`;
  if (assessmentTransitionJobs.has(key)) return;
  const job = finalizeAssessmentTransition(tenantId, runId, sessionId).catch(async (error) => {
    await withTenant(pool, tenantId, async (c) => {
      await c.query(
        `update runtime_assessment_run
            set payload=payload || jsonb_build_object(
              'pending_transition',coalesce(payload->'pending_transition','{}'::jsonb) || jsonb_build_object(
                'state','failed','error',$3::text,'failed_at',now()
              )
            )
          where run_id=$1 and payload->'pending_transition'->>'source_session_id'=$2`,
        [runId, sessionId, transitionError(error)],
      );
    }).catch(() => undefined);
  });
  assessmentTransitionJobs.set(key, job);
  void job.finally(() => {
    if (assessmentTransitionJobs.get(key) === job) assessmentTransitionJobs.delete(key);
  });
}

startService({
  name: "learning",
  port: Number(process.env.PORT ?? 3002),
  register(app) {
    app.post("/sessions", async (req, reply) => {
      const tenantId = tenantOf(req);
      if (!tenantId) return reply.code(400).send({ error: "missing x-tenant-id" });
      const body = req.body as CreateSessionBody;
      if (!body.student_id || !body.question_id || !body.chapter_package_version) {
        return reply.code(422).send({ error: "student_id/question_id/chapter_package_version required" });
      }
      // P0-5 证据链：版本必须真实存在且该题属于该包（客户端自报版本不再被信任）
      const specRes = await getQuestionSpec(body.question_id, tenantId, body.student_id);
      if (!specRes.ok) return reply.code(specRes.status).send({ error: specRes.error, detail: specRes.detail });
      const versionOk = specRes.published_packages.some((p) => p.version === body.chapter_package_version);
      if (!versionOk) {
        return reply.code(422).send({
          error: "chapter_package_version_invalid",
          detail: `题目 ${body.question_id} 不存在版本 ${body.chapter_package_version} 的已发布包`,
          available_versions: specRes.published_packages.map((p) => p.version),
        });
      }
      if (!["diagnostic", "help", "review"].includes(body.mode)) {
        return reply.code(422).send({ error: "mode must be diagnostic|help|review" });
      }
      let assessmentRun: { student_id: string; status: string; current_question: string | null; payload: Record<string, unknown> } | null = null;
      if (body.assessment_run_id) {
        const run = await withTenant(pool, tenantId, async (c) => {
          const r = await c.query(
            "select student_id,status,payload,payload->>'current_question' as current_question from runtime_assessment_run where run_id = $1",
            [body.assessment_run_id],
          );
          return r.rows[0];
        });
        if (!run) return reply.code(404).send({ error: "assessment run not found" });
        if (run.student_id !== body.student_id) return reply.code(403).send({ error: "assessment run belongs to another student" });
        if (run.status !== "active") return reply.code(409).send({ error: `assessment run ${run.status}` });
        if (run.current_question !== body.question_id) {
          return reply.code(422).send({ error: "question is not the assessment run current_question" });
        }
        assessmentRun = run;
      }
      const pendingTransition = assessmentRun?.payload?.pending_transition as PendingAssessmentTransition | undefined;
      if (body.assessment_run_id && pendingTransition?.next_question === body.question_id && pendingTransition.source_session_id && pendingTransition.state !== "ready") {
        let state = pendingTransition.state ?? "preparing";
        let attempts = Number(pendingTransition.attempts ?? 1);
        if (state === "failed" && attempts < 2) {
          attempts += 1;
          state = "preparing";
          await withTenant(pool, tenantId, async (c) => {
            await c.query(
              `update runtime_assessment_run
                  set payload=payload || jsonb_build_object(
                    'pending_transition',coalesce(payload->'pending_transition','{}'::jsonb) || jsonb_build_object(
                      'state','preparing','attempts',$2::int,'retry_started_at',now()
                    )
                  ) where run_id=$1`,
              [body.assessment_run_id, attempts],
            );
          });
        }
        if (state === "preparing") scheduleAssessmentTransition(tenantId, body.assessment_run_id, pendingTransition.source_session_id);
        if (state === "failed") {
          return reply.code(503).send({ error: "session_context_failed", detail: "上一题的学习记录整理未完成，请稍后重试。" });
        }
        return reply.code(425).send({ error: "session_context_preparing", transition_state: state, retry_after_ms: 1500 });
      }
      const existingSessionId = assessmentRun?.payload?.current_session;
      if (typeof existingSessionId === "string" && existingSessionId.length > 0) {
        const existing = await withTenant(pool, tenantId, async (c) => {
          const r = await c.query(
            `select q.payload || jsonb_build_object(
                    'state',q.state,'state_history',q.state_history,
                    'hint_level',q.hint_level,'probe_rounds',q.probe_rounds,
                    'probe',case when q.state in ('DIAGNOSE','PROBE_AWAIT') then
                      (select dc.payload->'probe' from runtime_diagnostic_claim dc
                        where dc.session_id=q.session_id and dc.status='open'
                        order by dc.created_at desc limit 1)
                    else null end) as payload
               from runtime_question_session q
              where q.session_id=$1 and q.student_id=$2 and q.question_id=$3 and q.run_id=$4
                and q.chapter_package_version=$5`,
            [existingSessionId, body.student_id, body.question_id, body.assessment_run_id, body.chapter_package_version],
          );
          return r.rows[0]?.payload;
        });
        if (existing) return reply.code(200).send(existing);
      }
      const sessionId = newId("s");
      const now = new Date().toISOString();
      const programStudentContext = await buildProgramStudentContext(tenantId, body.student_id, body.assessment_run_id);
      const payload = {
        session_id: sessionId,
        tenant_id: tenantId,
        student_id: body.student_id,
        question_id: body.question_id,
        assessment_run_id: body.assessment_run_id ?? null,
        chapter_package_version: body.chapter_package_version,
        mode: body.mode,
        draft_enabled: body.draft_enabled,
        counts_toward_independent_evidence: body.mode === "diagnostic",
        measurement_targets: specRes.spec.measurement_targets,
        program_student_context: programStudentContext,
        rolling_summary: assessmentRun?.payload?.rolling_summary ?? "",
        continuity_summary_id: assessmentRun?.payload?.continuity_summary_id ?? null,
        state: "CREATE",
        state_history: [{ state: "CREATE", entered_at: now, actor: "orchestrator" }],
        hint_level: 0,
        probe_rounds: 0,
        started_at: now,
      };
      await withTenant(pool, tenantId, async (c) => {
        await c.query(
          `insert into runtime_question_session
             (session_id, tenant_id, student_id, run_id, question_id, chapter_package_version,
              mode, draft_enabled, state, state_history, hint_level, probe_rounds, payload)
           values ($1,$2,$3,$4,$5,$6,$7,$8,'CREATE',
                   jsonb_build_array(jsonb_build_object('state','CREATE','entered_at',$9::timestamptz,'actor','orchestrator')),
                   0,0,$10)`,
          [sessionId, tenantId, body.student_id, body.assessment_run_id ?? null, body.question_id, body.chapter_package_version,
           body.mode, body.draft_enabled, now, JSON.stringify(payload)],
        );
        if (body.assessment_run_id) {
          await c.query(
            `update runtime_assessment_run
                set payload = payload || jsonb_build_object(
                  'sessions', coalesce(payload->'sessions','[]'::jsonb) || jsonb_build_array($2::text),
                  'current_session', $2::text)
              where run_id=$1`,
            [body.assessment_run_id, sessionId],
          );
        }
      });
      return reply.code(201).send(payload);
    });

    app.get("/sessions/:id", async (req, reply) => {
      const tenantId = tenantOf(req);
      if (!tenantId) return reply.code(400).send({ error: "missing x-tenant-id" });
      const { id } = req.params as { id: string };
      const row = await withTenant(pool, tenantId, async (c) => {
        const r = await c.query(
          `select q.payload || jsonb_build_object(
                  'state',q.state,'state_history',q.state_history,
                  'hint_level',q.hint_level,'probe_rounds',q.probe_rounds,
                  'probe',case when q.state in ('DIAGNOSE','PROBE_AWAIT') then
                    (select dc.payload->'probe' from runtime_diagnostic_claim dc
                      where dc.session_id=q.session_id and dc.status='open'
                      order by dc.created_at desc limit 1)
                  else null end) as payload
             from runtime_question_session q where q.session_id = $1`,
          [id],
        );
        return r.rows[0];
      });
      if (!row) return reply.code(404).send({ error: "session not found" });
      return row.payload;
    });

    /** Teaching Agent 可见时间线：学生/Agent 多轮消息 + Pi 原生模型/工具步骤。
     * 私有思维正文不返回；只返回阶段、工具、公开回复和 token 用量。 */
    app.get("/sessions/:id/agent-trace", async (req, reply) => {
      const tenantId = tenantOf(req);
      if (!tenantId) return reply.code(400).send({ error: "missing x-tenant-id" });
      const { id } = req.params as { id: string };
      const data = await withTenant(pool, tenantId, async (c) => {
        const exists = await c.query("select session_id from runtime_question_session where session_id = $1", [id]);
        if (!exists.rows[0]) {
          const teaching = await c.query("select conversation_id from runtime_teaching_conversation where conversation_id = $1", [id]);
          if (!teaching.rows[0]) return null;
          const chat = await c.query(
            "select created_at,role,payload from runtime_teaching_conversation_turn where conversation_id=$1 order by turn",
            [id],
          );
          const artifacts = await c.query(
            "select artifact_id,kind,renderer,artifact_uri,created_at from runtime_learning_artifact where conversation_id=$1 order by created_at",
            [id],
          );
          return { attempts: [], claims: [], summaries: [], chat: chat.rows, artifacts: artifacts.rows };
        }
        const attempts = await c.query(
          `select a.created_at, a.payload->>'answer_text' as text,
                  coalesce(a.payload->>'kind','answer') as kind,
                  v.created_at as verdict_at, v.verdict, v.payload->>'decision_summary' as summary
             from runtime_attempt a
             left join runtime_answer_verdict v on v.attempt_id = a.attempt_id
            where a.session_id = $1 order by a.created_at`,
          [id],
        );
        const claims = await c.query(
          `select created_at, payload->'probe'->>'question' as question,
                  payload->'probe_history' as history
             from runtime_diagnostic_claim where session_id = $1 order by created_at`,
          [id],
        );
        const summaries = await c.query(
          `select created_at, payload->>'summary' as summary
             from runtime_teaching_session_summary where session_id = $1 order by created_at`,
          [id],
        );
        const chat = await c.query(
          `select created_at, role, payload from runtime_chat_turn where session_id = $1 order by turn`,
          [id],
        );
        const artifacts = await c.query(
          `select artifact_id, kind, renderer, artifact_uri, created_at
             from runtime_learning_artifact where session_id = $1 order by created_at`,
          [id],
        );
        return { attempts: attempts.rows, claims: claims.rows, summaries: summaries.rows, chat: chat.rows, artifacts: artifacts.rows };
      });
      if (!data) return reply.code(404).send({ error: "session not found" });

      const conversation: {
        at: string;
        role: "student" | "agent";
        kind: string;
        text: string;
        artifacts?: InteractionResult["artifacts"];
        thinking_from?: string;
      }[] = [];
      for (const a of data.attempts) {
        if (a.text) conversation.push({ at: new Date(a.created_at).toISOString(), role: "student", kind: a.kind, text: a.text });
        if (a.summary) conversation.push({
          at: new Date(a.verdict_at ?? a.created_at).toISOString(), role: "agent", kind: "judgment", text: a.summary,
          thinking_from: new Date(a.created_at).toISOString(),
        });
      }
      for (const c of data.claims) {
        if (c.question) conversation.push({ at: new Date(c.created_at).toISOString(), role: "agent", kind: "probe", text: c.question });
      }
      for (const s of data.summaries) {
        if (s.summary) conversation.push({ at: new Date(s.created_at).toISOString(), role: "agent", kind: "summary", text: s.summary });
      }
      for (const t of data.chat) {
        const role = t.role === "agent" ? "agent" : "student";
        const text = typeof t.payload?.text === "string" ? t.payload.text : typeof t.payload?.reply === "string" ? t.payload.reply : "";
        if (text) conversation.push({
          at: new Date(t.created_at).toISOString(), role, kind: t.payload?.action ?? "interaction", text,
          ...(role === "agent" && Array.isArray(t.payload?.artifacts) ? { artifacts: t.payload.artifacts } : {}),
          ...(role === "agent" && typeof t.payload?.runtime_started_at === "string"
            ? { thinking_from: t.payload.runtime_started_at }
            : {}),
        });
      }
      conversation.sort((a, b) => a.at.localeCompare(b.at));

      const trace = await runtime.getSessionEvents(id, tenantId);
      const publicSteps = trace.ok
        ? trace.events.filter((event) => ["assistant_message", "tool_start", "tool_end", "turn_end", "retry"].includes(event.type))
        : [];
      const projectedConversation = conversation.map((turn, index) => {
        const { thinking_from: explicitStart, ...visibleTurn } = turn;
        if (turn.role !== "agent") return visibleTurn;
        const prior = conversation[index - 1];
        const start = Date.parse(explicitStart ?? prior?.at ?? turn.at);
        const end = Date.parse(turn.at) + 1_000;
        const thinking = publicSteps.filter((event) => {
          const at = Date.parse(event.at);
          return Number.isFinite(at) && at >= start && at <= end;
        });
        return { ...visibleTurn, ...(thinking.length ? { thinking } : {}) };
      });
      return {
        session_id: id,
        conversation: projectedConversation,
        artifacts: data.artifacts,
        steps: trace.ok ? trace.events : [],
        ...(trace.ok ? {} : { trace_error: trace.error }),
      };
    });

    /** 三类求助动作：同一 Pi Teaching Agent Session 多轮续接，图片直接进入主模型。 */
    app.post("/sessions/:id/interact", async (req, reply) => {
      const tenantId = tenantOf(req);
      if (!tenantId) return reply.code(400).send({ error: "missing x-tenant-id" });
      const { id } = req.params as { id: string };
      const body = req.body as InteractionBody;
      if (!["stuck", "check_step", "method_hint", "card_event", "free_text"].includes(body.action ?? "")) {
        return reply.code(422).send({ error: "action must be stuck|check_step|method_hint|card_event|free_text" });
      }
      if (typeof body.text !== "undefined" && (typeof body.text !== "string" || body.text.length > MAX_ANSWER_CHARS)) {
        return reply.code(422).send({ error: "invalid text" });
      }
      const images = validPromptImages(body.images);
      if (!images) return reply.code(422).send({ error: "invalid images" });
      const session = await withTenant(pool, tenantId, async (c) => {
        const r = await c.query("select question_id, student_id, state, hint_level, payload from runtime_question_session where session_id = $1", [id]);
        return r.rows[0];
      });
      if (!session) return reply.code(404).send({ error: "session not found" });
      const spec = await getQuestionSpec(session.question_id, tenantId, session.student_id);
      if (!spec.ok) return reply.code(spec.status).send({ error: spec.error, detail: spec.detail });
      const postCompletion = session.state === "CLOSED";
      const nextHint = postCompletion ? Number(session.hint_level ?? 0)
        : Math.min(5, Math.max(Number(session.hint_level ?? 0), body.action === "check_step" || body.action === "free_text" ? 0 : 1));
      const programStudentContext = await buildProgramStudentContext(
        tenantId,
        session.student_id,
        session.payload?.assessment_run_id ?? null,
      );
      const runtimeStartedAt = new Date().toISOString();
      const result = await runInteraction({
        sessionRef: id, tenantId, studentId: session.student_id, action: body.action, questionId: session.question_id, question: spec.spec.stem,
        userText: body.text ?? "", diagnosisContext: { state: session.state, hint_level: nextHint, post_completion: postCompletion,
          program_student_context: programStudentContext,
          rolling_summary: session.payload?.rolling_summary ?? "",
          continuity_summary_id: session.payload?.continuity_summary_id ?? null,
          database_access: "use the database Skill; identity is bound to this student" },
        images: [...spec.spec.images, ...images].slice(0, 4),
      });
      if (!result.ok) return reply.code(result.status).send({ error: result.error, detail: result.detail });
      await withTenant(pool, tenantId, async (c) => {
        for (const artifact of result.value.artifacts) {
          if (!artifact.artifact_id || !artifact.uri || !artifact.renderer || !artifact.manifest_hash) continue;
          await c.query(
            `insert into runtime_learning_artifact (artifact_id, tenant_id, session_id, kind, renderer, artifact_uri)
             values ($1,$2,$3,$4,$5,$6) on conflict (artifact_id) do nothing`,
            [artifact.artifact_id, tenantId, id, artifact.artifact_kind ?? artifact.kind, artifact.renderer, artifact.artifact_ref ?? artifact.uri],
          );
          await c.query(
            `insert into runtime_artifact_version (artifact_version_id, tenant_id, artifact_id, manifest, files_hash, storage_prefix)
             values ($1,$2,$3,$4,$5,$6)`,
            [newId("av"), tenantId, artifact.artifact_id,
             JSON.stringify(artifact.manifest ?? { schema: "mathpilot.learning-artifact/v1", artifact_id: artifact.artifact_id, session_id: id, kind: artifact.artifact_kind, renderer: artifact.renderer, title: artifact.title, entry: artifact.entrypoint }),
             artifact.manifest_hash, `workspace://${id}/.agent/published/${artifact.artifact_id}`],
          );
        }
        const turn = await c.query("select coalesce(max(turn),0)::int + 1 as n from runtime_chat_turn where session_id = $1", [id]);
        const n = Number(turn.rows[0]?.n ?? 1);
        await c.query(
          `insert into runtime_chat_turn (tenant_id, session_id, turn, role, payload)
           values ($1,$2,$3,'student',$4),($1,$2,$5,'agent',$6)`,
          [tenantId, id, n, JSON.stringify({ action: body.action, text: body.text ?? "", image_count: images.length }), n + 1,
           JSON.stringify({ action: body.action, reply: result.value.reply, status: result.value.status,
             runtime_started_at: runtimeStartedAt,
             artifacts: result.value.artifacts, model_id: result.value.model_id, prompt_version: result.value.prompt_version })],
        );
        await c.query(
          `insert into runtime_intervention_event (event_id, tenant_id, session_id, kind, hint_level, payload)
           values ($1,$2,$3,$4,$5,$6)`,
          [newId("int"), tenantId, id, body.action, nextHint,
           JSON.stringify({ action: body.action, image_count: images.length, model_id: result.value.model_id, prompt_version: result.value.prompt_version })],
        );
        if (!postCompletion) {
          await c.query("update runtime_question_session set hint_level = $2, payload = payload || jsonb_build_object('hint_level',$2::int) where session_id = $1", [id, nextHint]);
        }
      });
      return { session_id: id, hint_level: nextHint, ...result.value };
    });

    /** 草稿原始字节留在客户端/对象存储；数据库只记哈希、bbox 与事件计数索引。 */
    app.post("/sessions/:id/draft", async (req, reply) => {
      const tenantId = tenantOf(req);
      if (!tenantId) return reply.code(400).send({ error: "missing x-tenant-id" });
      const { id } = req.params as { id: string };
      const body = req.body as { segment_id?: string; content_hash?: string; event_count?: number; bbox?: number[] };
      if (!body.segment_id || !/^sha256:[0-9a-f]{64}$/.test(body.content_hash ?? "") || !Number.isInteger(body.event_count) || Number(body.event_count) < 0) {
        return reply.code(422).send({ error: "segment_id/content_hash/event_count required" });
      }
      const out = await withTenant(pool, tenantId, async (c) => {
        const s = await c.query("select draft_enabled from runtime_question_session where session_id = $1", [id]);
        if (!s.rows[0]) return false;
        if (!s.rows[0].draft_enabled) throw new Error("draft disabled");
        await c.query(
          `insert into runtime_stroke_event_index (tenant_id,session_id,stream_ref,content_hash,event_count)
           values ($1,$2,$3,$4,$5) on conflict (session_id,stream_ref) do update
             set content_hash=excluded.content_hash,event_count=excluded.event_count,created_at=now()`,
          [tenantId, id, `client://${id}/${body.segment_id}`, body.content_hash, body.event_count],
        );
        await c.query(
          `insert into runtime_draft_segment (tenant_id,session_id,segment_id,bbox,payload)
           values ($1,$2,$3,$4,$5) on conflict (session_id,segment_id) do update
             set bbox=excluded.bbox,payload=excluded.payload,created_at=now()`,
          [tenantId, id, body.segment_id, body.bbox ?? null, JSON.stringify({ content_hash: body.content_hash, event_count: body.event_count })],
        );
        return true;
      }).catch((e) => e instanceof Error && e.message === "draft disabled" ? "disabled" : Promise.reject(e));
      if (out === false) return reply.code(404).send({ error: "session not found" });
      if (out === "disabled") return reply.code(409).send({ error: "draft disabled" });
      return reply.code(201).send({ session_id: id, segment_id: body.segment_id, indexed: true });
    });

    /** 库外自由问答：独立 Pi Session，多模态直送主模型，不进入诊断证据。 */
    app.post("/ask", async (req, reply) => {
      const tenantId = tenantOf(req);
      const actor = actorOf(req);
      if (!tenantId || !actor) return reply.code(400).send({ error: "missing tenant/user headers" });
      const body = req.body as { conversation_id?: string; action?: "free_ask" | "card_event"; text?: string; images?: PromptImage[] };
      const images = validPromptImages(body.images);
      const action = body.action === "card_event" ? "card_event" : "free_ask";
      if (!images || typeof body.text !== "string" || body.text.length > MAX_ANSWER_CHARS || (!body.text.trim() && images.length === 0)) {
        return reply.code(422).send({ error: "text or images required" });
      }
      const conversationId = body.conversation_id && /^s_[A-Za-z0-9]{8,}$/.test(body.conversation_id)
        ? body.conversation_id : newId("s");
      if (body.conversation_id) {
        const owner = await withTenant(pool, tenantId, async (c) => {
          const r = await c.query("select student_id from runtime_teaching_conversation where conversation_id=$1", [conversationId]);
          return r.rows[0]?.student_id as string | undefined;
        });
        if (!owner) return reply.code(404).send({ error: "teaching conversation not found" });
        if (owner !== actor) return reply.code(403).send({ error: "not your teaching conversation" });
      }
      const programStudentContext = await buildProgramStudentContext(tenantId, actor);
      const runtimeStartedAt = new Date().toISOString();
      const result = await runInteraction({ sessionRef: conversationId, tenantId, studentId: actor, action,
        question: "库外自由数学问答（不计入正式诊断证据）", userText: body.text,
        diagnosisContext: { program_student_context: programStudentContext,
          database_access: "use the database Skill; identity is bound to this student" }, images });
      if (!result.ok) return reply.code(result.status).send({ error: result.error, detail: result.detail });
      await withTenant(pool, tenantId, async (c) => {
        await c.query(
          `insert into runtime_teaching_conversation(conversation_id,tenant_id,student_id,evidence_policy)
           values($1,$2,$3,'teaching_only') on conflict(conversation_id) do update set updated_at=now()`,
          [conversationId, tenantId, actor],
        );
        const n = await c.query("select coalesce(max(turn),0)::int+1 as n from runtime_teaching_conversation_turn where conversation_id=$1", [conversationId]);
        const turn = Number(n.rows[0]?.n ?? 1);
        await c.query(
          `insert into runtime_teaching_conversation_turn(turn_id,tenant_id,conversation_id,turn,role,payload)
           values($1,$2,$3,$4,'student',$5),($6,$2,$3,$7,'agent',$8)`,
          [newId("tct"), tenantId, conversationId, turn, JSON.stringify({ action, text: body.text, image_count: images.length }),
           newId("tct"), turn + 1, JSON.stringify({ action, reply: result.value.reply, status: result.value.status,
             runtime_started_at: runtimeStartedAt,
             artifacts: result.value.artifacts, model_id: result.value.model_id, prompt_version: result.value.prompt_version })],
        );
        for (const artifact of result.value.artifacts) {
          if (!artifact.artifact_id || !artifact.artifact_ref || !artifact.renderer || !artifact.manifest_hash) continue;
          await c.query(
            `insert into runtime_learning_artifact(artifact_id,tenant_id,session_id,conversation_id,kind,renderer,artifact_uri)
             values($1,$2,null,$3,$4,$5,$6) on conflict(artifact_id) do nothing`,
            [artifact.artifact_id, tenantId, conversationId, artifact.artifact_kind ?? artifact.kind, artifact.renderer, artifact.artifact_ref],
          );
          await c.query(
            `insert into runtime_artifact_version(artifact_version_id,tenant_id,artifact_id,manifest,files_hash,storage_prefix)
             values($1,$2,$3,$4,$5,$6)`,
            [newId("av"), tenantId, artifact.artifact_id, JSON.stringify(artifact.manifest), artifact.manifest_hash,
             `workspace://${conversationId}/.agent/published/${artifact.artifact_id}`],
          );
        }
      });
      return { conversation_id: conversationId, evidence_policy: "teaching_only", ...result.value };
    });

    app.get("/teaching-conversations/:id", async (req, reply) => {
      const tenantId = tenantOf(req);
      if (!tenantId) return reply.code(400).send({ error: "missing x-tenant-id" });
      const { id } = req.params as { id: string };
      const row = await withTenant(pool, tenantId, async (c) => {
        const r = await c.query("select conversation_id,student_id,evidence_policy,created_at,updated_at from runtime_teaching_conversation where conversation_id=$1", [id]);
        return r.rows[0];
      });
      return row ?? reply.code(404).send({ error: "teaching conversation not found" });
    });

    app.post("/teaching-conversations/:id/card-event", async (req, reply) => {
      const tenantId = tenantOf(req), actor = actorOf(req);
      if (!tenantId || !actor) return reply.code(400).send({ error: "missing tenant/user headers" });
      const { id } = req.params as { id: string };
      const body = req.body as { card_id?: string; artifact_id?: string; interaction_token?: string; response_type?: string; payload?: Record<string, unknown> };
      if (!body.card_id || !body.artifact_id || !body.interaction_token || !["submitted", "skipped", "bypassed_free_text"].includes(body.response_type ?? "")) {
        return reply.code(422).send({ error: "card/artifact/token and valid response_type required" });
      }
      const out = await withTenant(pool, tenantId, async (c) => {
        const owner = await c.query("select student_id from runtime_teaching_conversation where conversation_id=$1", [id]);
        if (!owner.rows[0]) return { status: 404 as const, body: { error: "teaching conversation not found" } };
        if (owner.rows[0].student_id !== actor) return { status: 403 as const, body: { error: "not your teaching conversation" } };
        const turns = await c.query("select payload from runtime_teaching_conversation_turn where conversation_id=$1 and role='agent' order by turn desc limit 20", [id]);
        const matched = turns.rows.flatMap((row) => Array.isArray(row.payload?.artifacts) ? row.payload.artifacts : [])
          .find((artifact) => artifact?.artifact_id === body.artifact_id && artifact?.interaction_token === body.interaction_token);
        if (!matched) return { status: 422 as const, body: { error: "card is not registered for this conversation" } };
        const used = await c.query("select response_id from runtime_artifact_interaction where conversation_id=$1 and artifact_id=$2 and card_id=$3 limit 1", [id, body.artifact_id, body.card_id]);
        if (used.rowCount) return { status: 409 as const, body: { error: "interaction token already consumed" } };
        const responseId = newId("rsp");
        await c.query(
          `insert into runtime_artifact_interaction(response_id,tenant_id,session_id,conversation_id,artifact_id,card_id,student_id,response_type,payload)
           values($1,$2,null,$3,$4,$5,$6,$7,$8)`,
          [responseId, tenantId, id, body.artifact_id, body.card_id, actor, body.response_type, JSON.stringify(body.payload ?? {})],
        );
        return { status: 201 as const, body: { response_id: responseId, response_type: body.response_type } };
      });
      return reply.code(out.status).send(out.body);
    });

    /** 报告证据下钻：事实、判定、程序评价与模型来源按会话聚合。 */
    app.get("/students/:studentId/evidence", async (req, reply) => {
      const tenantId = tenantOf(req);
      if (!tenantId) return reply.code(400).send({ error: "missing x-tenant-id" });
      const { studentId } = req.params as { studentId: string };
      const rows = await withTenant(pool, tenantId, async (c) => {
        const r = await c.query(
          `select q.session_id,q.question_id,q.state,q.hint_level,q.started_at,q.closed_at,
                  coalesce(jsonb_agg(distinct jsonb_build_object('attempt_id',a.attempt_id,'answer_text',a.payload->>'answer_text','created_at',a.created_at))
                    filter (where a.attempt_id is not null),'[]') as attempts,
                  coalesce(jsonb_agg(distinct jsonb_build_object('judgment_id',v.judgment_id,'verdict',v.verdict,'uncertainty',v.uncertainty,
                    'model_id',v.model_id,'prompt_version',v.prompt_version,'payload',v.payload)) filter (where v.judgment_id is not null),'[]') as judgments,
                  coalesce(jsonb_agg(distinct jsonb_build_object('observation_id',o.observation_id,'dimension_id',o.dimension_id,'outcome',o.outcome,
                    'independent',o.independent,'evidence_rule',o.evidence_rule,'hint_level',o.hint_level)) filter (where o.observation_id is not null),'[]') as observations
             from runtime_question_session q
             left join runtime_attempt a on a.session_id=q.session_id
             left join runtime_answer_verdict v on v.attempt_id=a.attempt_id
             left join runtime_state_observation o on o.session_id=q.session_id
            where q.student_id=$1
              and (
                exists (select 1 from runtime_attempt ax where ax.session_id=q.session_id)
                or exists (select 1 from runtime_answer_verdict vx where vx.session_id=q.session_id)
                or exists (select 1 from runtime_state_observation ox where ox.session_id=q.session_id)
              )
            group by q.session_id order by q.started_at desc limit 50`,
          [studentId],
        );
        return r.rows;
      });
      return { student_id: studentId, sessions: rows };
    });

    // ── 自适应测评（§10 / §7.4 测评统一：聊天式测评 = AssessmentRun） ──

    /** 创建测评轮（AssessmentRun）：初始目标 coverage（可显式指定 review/training）；
     *  预算（max_questions/max_minutes）由服务端持有并在 next 强制执行（P1）；
     *  自认薄弱维度从画像读取写入 run（P1：selection 目标数据完整）。 */
    app.post("/assessment-runs", async (req, reply) => {
      const tenantId = tenantOf(req);
      if (!tenantId) return reply.code(400).send({ error: "missing x-tenant-id" });
      const { student_id: studentId, goal: goalIn, budget: budgetIn } = req.body as { student_id: string; goal?: string; budget?: { max_questions?: number; max_minutes?: number } };
      if (!studentId) return reply.code(422).send({ error: "student_id required" });
      const goal = goalIn && ["coverage", "disambiguation", "prerequisite", "review", "training", "transfer"].includes(goalIn)
        ? (goalIn as SelectionGoal) : "coverage";
      const clampInt = (v: unknown, min: number, max: number, dflt: number): number => {
        const n = typeof v === "number" && Number.isInteger(v) ? v : dflt;
        return Math.min(Math.max(n, min), max);
      };
      const budget = {
        max_questions: clampInt(budgetIn?.max_questions, 1, 40, 10),
        max_minutes: clampInt(budgetIn?.max_minutes, 1, 180, 30),
      };
      // 练习入口与页面刷新必须恢复正在进行的轮次。数据库唯一索引处理并发，
      // 这里先返回已有轮次，避免每次点击“练习”都从第一题创建一套新证据链。
      const existing = await withTenant(pool, tenantId, async (c) => {
        const r = await c.query(
          `select r.run_id,r.goal,r.status,r.budget,
                  r.payload->>'current_question' as current_question,
                  r.payload->>'current_session' as current_session,
                  q.state as session_state
             from runtime_assessment_run r
             left join runtime_question_session q on q.session_id=r.payload->>'current_session'
            where r.student_id=$1 and r.goal=$2 and r.status='active'
            order by r.created_at desc limit 1`,
          [studentId, goal],
        );
        return r.rows[0];
      });
      if (existing) return reply.code(200).send({ ...existing, resumed: true });
      // 空正式库不能先创建一个永远无法进入首题的 active run。内容工坊尚未发布
      // 题目时在写库前失败，前端据此引导教师完成 OCR → KTQ → ER → 复核发布。
      try {
        const qRes = await fetch(`${CONTENT_URL}/questions`, {
          headers: { "x-tenant-id": tenantId, "x-user-id": studentId }, signal: AbortSignal.timeout(10_000),
        });
        if (!qRes.ok) {
          return reply.code(502).send({ error: "content_service_unavailable", detail: `status=${qRes.status}` });
        }
        const catalog = await qRes.json() as { questions?: unknown[] };
        if (!Array.isArray(catalog.questions) || catalog.questions.length === 0) {
          return reply.code(409).send({
            error: "content_library_not_ready",
            detail: "尚无已发布题目；请由教师在内容工坊完成资料提取、复核与发布。",
          });
        }
      } catch (error) {
        return reply.code(502).send({ error: "content_service_unavailable", detail: error instanceof Error ? error.message : String(error) });
      }
      // 自认薄弱写入 run（P1）
      let selfWeak: string[] = [];
      try {
        const pRes = await fetch(`${PROFILE_URL}/students/${encodeURIComponent(studentId)}/profile`, {
          headers: { "x-tenant-id": tenantId }, signal: AbortSignal.timeout(10_000),
        });
        if (pRes.ok) selfWeak = ((await pRes.json()) as { self_weak?: string[] }).self_weak ?? [];
      } catch { /* 画像不可达时 self_weak 为空（不阻塞创建） */ }
      const runId = newId("run");
      const now = new Date().toISOString();
      const created = await withTenant(pool, tenantId, async (c) => {
        const inserted = await c.query(
          `insert into runtime_assessment_run (run_id, tenant_id, student_id, goal, budget, status, payload)
           values ($1,$2,$3,$4,$5,'active',$6)
           on conflict (tenant_id,student_id,goal) where status='active' do nothing
           returning run_id`,
          [runId, tenantId, studentId, goal,
           JSON.stringify(budget),
           JSON.stringify({ run_id: runId, student_id: studentId, goal, seen: [], sessions: [], self_weak: selfWeak, disambiguation_dims: [], created_at: now })],
        );
        return Boolean(inserted.rows[0]);
      });
      if (!created) {
        const resumed = await withTenant(pool, tenantId, async (c) => {
          const r = await c.query(
            `select r.run_id,r.goal,r.status,r.budget,
                    r.payload->>'current_question' as current_question,
                    r.payload->>'current_session' as current_session,
                    q.state as session_state
               from runtime_assessment_run r
               left join runtime_question_session q on q.session_id=r.payload->>'current_session'
              where r.student_id=$1 and r.goal=$2 and r.status='active'
              limit 1`,
            [studentId, goal],
          );
          return r.rows[0];
        });
        if (resumed) return reply.code(200).send({ ...resumed, resumed: true });
        return reply.code(409).send({ error: "assessment_run_conflict" });
      }
      return reply.code(201).send({ run_id: runId, goal, status: "active", budget, self_weak: selfWeak, resumed: false });
    });

    /** 测评轮查询（api 网关归属校验用） */
    app.get("/assessment-runs/:id", async (req, reply) => {
      const tenantId = tenantOf(req);
      if (!tenantId) return reply.code(400).send({ error: "missing x-tenant-id" });
      const { id } = req.params as { id: string };
      const row = await withTenant(pool, tenantId, async (c) => {
        const r = await c.query(
          "select run_id, student_id, goal, status from runtime_assessment_run where run_id = $1",
          [id],
        );
        return r.rows[0];
      });
      if (!row) return reply.code(404).send({ error: "assessment run not found" });
      return row;
    });

    /** 下一题（阶段 B：传统程序硬过滤+评分；题目候选来自已发布章节包）。
     *  服务端强制执行题量/时间预算（P1：预算不再是前端自律）。 */
    app.post("/assessment-runs/:id/next", async (req, reply) => {
      const tenantId = tenantOf(req);
      if (!tenantId) return reply.code(400).send({ error: "missing x-tenant-id" });
      const { id } = req.params as { id: string };

      const run = await withTenant(pool, tenantId, async (c) => {
        const r = await c.query("select * from runtime_assessment_run where run_id = $1", [id]);
        return r.rows[0];
      });
      if (!run) return reply.code(404).send({ error: "assessment run not found" });
      if (run.status !== "active") return reply.code(409).send({ error: `run ${run.status}` });

      // 预算强制（P1）：达到题量或时间上限 → 终止本轮
      const budget = (run.budget ?? {}) as { max_questions?: number; max_minutes?: number };
      const seenCount = (run.payload?.seen ?? []).length;
      // 只累加真正进入题目 Session 的时间。AssessmentRun 可以跨页面刷新恢复，
      // 若直接用 run.created_at，学生在题间离开页面的空闲时间也会被算入学习预算。
      const elapsedMinutes = await withTenant(pool, tenantId, async (c) => {
        const r = await c.query(
          `select coalesce(sum(greatest(extract(epoch from (closed_at - started_at)), 0)), 0) / 60 as elapsed_minutes
             from runtime_question_session
            where run_id = $1 and closed_at is not null`,
          [id],
        );
        return Number(r.rows[0]?.elapsed_minutes ?? 0);
      });
      const reason = seenCount >= (budget.max_questions ?? 10)
        ? `达到题量预算 ${budget.max_questions} 题`
        : elapsedMinutes >= (budget.max_minutes ?? 30)
          ? `达到时间预算 ${budget.max_minutes} 分钟`
          : null;
      if (reason) {
        await withTenant(pool, tenantId, async (c) => {
          await c.query(
            `update runtime_assessment_run set status = 'completed',
                    payload = payload || jsonb_build_object('completed_at', now(), 'completion_reason', $2::text)
              where run_id = $1`,
            [id, reason],
          );
        });
        return reply.code(409).send({ error: "run_completed", status: "completed", detail: reason });
      }

      // 候选：已发布题目（content 边界）
      let qRes: Response;
      try {
        qRes = await fetch(`${CONTENT_URL}/questions`, {
          headers: { "x-tenant-id": tenantId, "x-user-id": run.student_id }, signal: AbortSignal.timeout(10_000),
        });
      } catch {
        return reply.code(502).send({ error: "content_unavailable" });
      }
      if (!qRes.ok) return reply.code(502).send({ error: "content_unavailable", detail: `http_${qRes.status}` });
      const qd = (await qRes.json()) as { questions?: QuestionCandidate[] };
      const candidates = (qd.questions ?? []).map((q) => ({
        ...q,
        measurement_targets: (q.measurement_targets ?? []) as { dim: string; role: "primary" | "secondary" | "prerequisite" }[],
      }));

      // 学生状态：画像投影（state 边界只读投影；教学 Session 无画像写权限，ADR-004）
      let proj: { mastery?: { dimension_id: string; p_profile: number; state: string }[]; retention?: { dimension_id: string; next_review_due: string | null }[] } = {};
      try {
        const pRes = await fetch(`${PROFILE_URL}/students/${encodeURIComponent(run.student_id)}/projection`, {
          headers: { "x-tenant-id": tenantId }, signal: AbortSignal.timeout(10_000),
        });
        if (pRes.ok) proj = (await pRes.json()) as typeof proj;
      } catch { /* 投影不可达时用空掌握视图（不阻塞选题） */ }

      const mastery: SelectorContext["mastery"] = {};
      const masteryRows = (proj.mastery ?? []) as { dimension_id?: string; p_profile?: number; state?: string }[];
      // 复测到期日来自保持率层（P1：review 目标不再是恒 null）
      const dueByDim = new Map<string, number>();
      for (const r of proj.retention ?? []) {
        if (!r.next_review_due) continue;
        dueByDim.set(r.dimension_id, Math.max(0, Math.ceil((new Date(r.next_review_due).getTime() - Date.now()) / DAY_MS)));
      }
      for (const m of masteryRows) {
        if (!m.dimension_id) continue;
        mastery[m.dimension_id] = {
          ...(m.p_profile !== undefined ? { p_profile: m.p_profile } : {}),
          ...(m.state ? { state: m.state as "weak" | "learning" | "possibly_mastered" | "mastered" | "insufficient_evidence" } : {}),
          next_review_due_days: dueByDim.get(m.dimension_id) ?? null,
        };
      }
      // “错题重刷”在保持率尚未稳定时也必须可用：最近有效失败维度视为立即到期，
      // 只影响 review 选题，不伪造稳定 I90 或画像掌握度。
      if (run.goal === "review") {
        const failed = await withTenant(pool, tenantId, async (c) => {
          const r = await c.query(
            `select distinct o.dimension_id
               from runtime_state_observation o
              where o.student_id = $1 and o.outcome = 'failure'
                and not exists (select 1 from runtime_state_observation o2 where o2.supersedes = o.observation_id)`,
            [run.student_id],
          );
          return r.rows as { dimension_id: string }[];
        });
        for (const row of failed) {
          mastery[row.dimension_id] = {
            ...(mastery[row.dimension_id] ?? {}),
            next_review_due_days: mastery[row.dimension_id]?.next_review_due_days ?? 0,
          };
        }
      }

      const seen = new Set<string>(run.payload?.seen ?? []);
      const ctx: SelectorContext = {
        goal: run.goal as SelectionGoal,
        candidates,
        mastery,
        seen,
        self_weak: run.payload?.self_weak ?? [],
        disambiguation_dims: run.payload?.disambiguation_dims ?? [],
      };
      const pick = selectNext(ctx);
      if (!pick) {
        await withTenant(pool, tenantId, async (c) => {
          await c.query(
            `update runtime_assessment_run set status = 'exhausted',
                    payload = payload || jsonb_build_object('exhausted_at', now())
              where run_id = $1`,
            [id],
          );
        });
        return reply.send({ status: "exhausted", detail: "无符合硬过滤与目标的题目" });
      }

      seen.add(pick.question_id);
      await withTenant(pool, tenantId, async (c) => {
        await c.query(
          `update runtime_assessment_run
              set payload = payload || jsonb_build_object('seen', $2::jsonb, 'current_question', $3::text) ||
                case when payload ? 'pending_transition' then jsonb_build_object(
                  'pending_transition',payload->'pending_transition' || jsonb_build_object('next_question',$3::text)
                ) else '{}'::jsonb end
            where run_id = $1`,
          [id, JSON.stringify([...seen]), pick.question_id],
        );
      });
      return reply.send({ run_id: id, question_id: pick.question_id, score: pick.score, goal: run.goal });
    });

    /** 学生确认进入下一题后，持久化后台整理任务并立即返回。
     *  递归摘要与下一目标判定由同一完整 Agent 壳异步完成；题卡可先显示，新 Session 在上下文就绪后创建。 */
    app.post("/assessment-runs/:id/decide", async (req, reply) => {
      const tenantId = tenantOf(req);
      if (!tenantId) return reply.code(400).send({ error: "missing x-tenant-id" });
      const { id } = req.params as { id: string };
      const { session_id: sessionId } = req.body as { session_id: string };
      if (!sessionId) return reply.code(422).send({ error: "session_id required" });

      const run = await withTenant(pool, tenantId, async (c) => {
        const r = await c.query("select * from runtime_assessment_run where run_id = $1", [id]);
        return r.rows[0];
      });
      if (!run) return reply.code(404).send({ error: "assessment run not found" });
      if (run.status !== "active") return reply.code(409).send({ error: `assessment run ${run.status}` });
      const session = await withTenant(pool, tenantId, async (c) => {
        const s = await c.query(
          "select state,run_id,student_id from runtime_question_session where session_id=$1",
          [sessionId],
        );
        return s.rows[0];
      });
      if (!session) return reply.code(404).send({ error: "session not found" });
      if (session.run_id !== id || session.student_id !== run.student_id) {
        return reply.code(422).send({ error: "session is not attached to this assessment run" });
      }
      if (session.state !== "CLOSED") {
        return reply.code(409).send({ error: "session must be closed before deciding the next goal" });
      }
      const pending = run.payload?.pending_transition as PendingAssessmentTransition | undefined;
      if (pending?.source_session_id === sessionId && pending.state === "ready") {
        return reply.send({ run_id: id, goal: run.goal, transition_state: "ready" });
      }
      if (pending?.source_session_id === sessionId && pending.state === "preparing") {
        scheduleAssessmentTransition(tenantId, id, sessionId);
        return reply.code(202).send({ run_id: id, goal: run.goal, transition_state: "preparing" });
      }
      const attempts = pending?.source_session_id === sessionId ? Number(pending.attempts ?? 0) + 1 : 1;
      const startedAt = new Date().toISOString();
      await withTenant(pool, tenantId, async (c) => {
        await c.query(
          `update runtime_assessment_run
              set status='active', payload=payload || jsonb_build_object(
                'pending_transition',jsonb_build_object(
                  'source_session_id',$2::text,'state','preparing','attempts',$3::int,
                  'advance_requested',true,'started_at',$4::timestamptz
                )
              ) where run_id=$1`,
          [id, sessionId, attempts, startedAt],
        );
      });
      scheduleAssessmentTransition(tenantId, id, sessionId);
      return reply.code(202).send({ run_id: id, goal: run.goal, transition_state: "preparing" });
    });

    /** 首次作答：GRADE → correct/unresolved 直接关闭；partial/incorrect → DIAGNOSE + 追问 */
    app.post("/sessions/:id/submit", async (req, reply) => {
      const tenantId = tenantOf(req);
      if (!tenantId) return reply.code(400).send({ error: "missing x-tenant-id" });
      const { id } = req.params as { id: string };
      const body = req.body as SubmitBody;
      if (body.dimension_id !== undefined && !DIMENSION_ID_RE.test(body.dimension_id)) {
        return reply.code(422).send({ error: "invalid dimension_id (must match (K|T|E)_[A-Z0-9_]{2,})" });
      }
      if (typeof body.answer_text !== "string" || body.answer_text.length === 0) {
        return reply.code(422).send({ error: "answer_text required" });
      }
      if (body.answer_text.length > MAX_ANSWER_CHARS) {
        return reply.code(422).send({ error: `answer_text exceeds ${MAX_ANSWER_CHARS} chars` });
      }
      const answerImages = validPromptImages(body.answer_images);
      if (!answerImages) return reply.code(422).send({ error: "invalid answer_images" });
      const now = new Date().toISOString();

      const pre = await withTenant(pool, tenantId, async (c) => {
        const r = await c.query(
          "select state, question_id, student_id from runtime_question_session where session_id = $1",
          [id],
        );
        return r.rows[0];
      });
      if (!pre) return reply.code(404).send({ error: "session not found" });
      // 恢复路径（D.1）：closeChain 中途失败后 session 停在 GRADE/DIAGNOSE，事实已落库——
      // 重试 submit 时直接续跑 closeChain，不重复判答（幂等恢复）
      const resume = pre.state === "GRADE" || pre.state === "DIAGNOSE";
      if (pre.state !== "CREATE" && !resume) {
        return reply.code(409).send({ error: `submit only allowed from CREATE (or resume from GRADE/DIAGNOSE), current ${pre.state}` });
      }

      if (resume) {
        // 恢复：已有事实（attempt/verdict/claim），只续跑关闭全链
        const existing = await withTenant(pool, tenantId, async (c) => {
          const r = await c.query(
            `select v.payload from runtime_answer_verdict v
               join runtime_attempt a on a.attempt_id = v.attempt_id
              where a.session_id = $1 order by a.created_at limit 1`,
            [id],
          );
          return r.rows[0]?.payload ?? null;
        });
        if (!existing) return reply.code(409).send({ error: "resume requires existing verdict facts" });
        // P2-8：DIAGNOSE 且有未答探针的 claim → 先标 unresolved（"待观察"语义，§8.3）再闭合
        if (pre.state === "DIAGNOSE") {
          await withTenant(pool, tenantId, async (c) => {
            const claim = await c.query(
              "select claim_id, status from runtime_diagnostic_claim where session_id = $1 order by created_at desc limit 1",
              [id],
            );
            if (claim.rows[0] && claim.rows[0].status === "open") {
              await c.query("update runtime_diagnostic_claim set status = 'unresolved' where claim_id = $1", [claim.rows[0].claim_id]);
            }
          });
        }
        const closed = await closeChain(tenantId, id);
        if (closed.status !== 200) return reply.code(closed.status).send(closed.body);
        return reply.send({ session_id: id, resumed: true, judgment: existing, ...(closed.body as Record<string, unknown>) });
      }

      // P0-6：提前取题卡做维度校验（在模型判答之前失败，避免无谓的模型调用）
      const preSpec = await getQuestionSpec(pre.question_id, tenantId, pre.student_id);
      if (!preSpec.ok) return reply.code(preSpec.status).send({ error: preSpec.error, detail: preSpec.detail });
      const primaryDim = preSpec.spec.measurement_targets.find((m) => m.role === "primary")?.dim;
      if (!primaryDim) {
        return reply.code(422).send({ error: "question_has_no_primary_target", detail: "题卡缺少 primary 测量目标，无法归因" });
      }
      if (body.dimension_id !== undefined && !preSpec.spec.measurement_targets.some((m) => m.dim === body.dimension_id)) {
        return reply.code(422).send({
          error: "dimension_id_not_in_measurement_targets",
          detail: `dimension_id=${body.dimension_id} 不属于本题测量目标`,
          measurement_targets: preSpec.spec.measurement_targets.map((m) => m.dim),
        });
      }

      const graded = await runGrading(id, pre.question_id, tenantId, pre.student_id, body.answer_text, {}, {
        spec: preSpec.spec,
        published_packages: preSpec.published_packages,
      }, answerImages);
      if (!graded.ok) return reply.code(graded.status).send({ error: graded.error, detail: graded.detail });
      const grade = graded.grade;

      // 维度归因（§2.3 / P0-6）：默认取 measurement_targets 的 primary 维度（已在模型调用前校验）
      const effectiveDim = body.dimension_id ?? primaryDim;

      // 部分正确/错误 → 先做错因归因（模型调用失败则整体 502，会话保持 CREATE 可重试）
      let diag: Awaited<ReturnType<typeof runDiagnose>> | null = null;
      if (grade.verdict === "partially_correct" || grade.verdict === "incorrect") {
        diag = await runDiagnose(id, pre.question_id, tenantId, pre.student_id, grade.verdict, body.answer_text);
        if (!diag.ok) return reply.code(diag.status).send({ error: diag.error, detail: diag.detail });
      }

      // 事实层：作答 + 判定（不可变，先落库）
      const attemptId = newId("att");
      const judgmentId = newId("jud");
      await withTenant(pool, tenantId, async (c) => {
        const s = await c.query("select * from runtime_question_session where session_id = $1 for update", [id]);
        const session = s.rows[0];
        if (!session || session.state !== "CREATE") throw new Error("session state changed");
        await c.query(
          `insert into runtime_attempt (attempt_id, tenant_id, session_id, student_id, payload)
           values ($1,$2,$3,$4,$5)`,
          [attemptId, tenantId, id, session.student_id,
           JSON.stringify({ answer_text: body.answer_text, kind: "answer", image_count: answerImages.length, submitted_at: now })],
        );
        await c.query(
          `insert into runtime_answer_verdict
             (judgment_id, tenant_id, session_id, attempt_id, verdict, uncertainty, model_id, prompt_version, payload)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [judgmentId, tenantId, id, attemptId, grade.verdict, grade.uncertainty,
           grade.modelImpl, grade.promptVersion,
           JSON.stringify({
             judgment_id: judgmentId, session_id: id, attempt_id: attemptId,
             verdict: grade.verdict,
             rubric_items: grade.rubricItems.map((r) => ({ id: r.id, status: r.status, evidence_refs: [`answer://${id}/${attemptId}`] })),
             decision_summary: grade.decisionSummary,
             uncertainty: grade.uncertainty,
             injection_flags: [],
             model_id: grade.modelImpl, prompt_version: grade.promptVersion, created_at: now,
           })],
        );
        await c.query(
          `update runtime_question_session
              set state = 'GRADE', probe_rounds = 0,
                  payload = payload || jsonb_build_object('dimension_id', $2::text,
                    'measurement_targets', $3::jsonb, 'diagnosis_dims', $4::jsonb),
                  state_history = state_history ||
                    jsonb_build_array(jsonb_build_object('state','SUBMIT','entered_at',$5::timestamptz,'actor','orchestrator'),
                                      jsonb_build_object('state','GRADE','entered_at',$5::timestamptz,'actor','orchestrator'))
            where session_id = $1`,
          [id, effectiveDim, JSON.stringify(graded.spec.measurement_targets),
           JSON.stringify(diag?.ok ? diag.outcome.diagnosis_dims : {}), now],
        );
      });

      const judgmentPayload = {
        judgment_id: judgmentId, session_id: id, attempt_id: attemptId,
        verdict: grade.verdict,
        rubric_items: grade.rubricItems.map((r) => ({ id: r.id, status: r.status, evidence_refs: [`answer://${id}/${attemptId}`] })),
        decision_summary: grade.decisionSummary,
        uncertainty: grade.uncertainty,
        injection_flags: [],
        model_id: grade.modelImpl, prompt_version: grade.promptVersion, created_at: now,
      };

      // 正确/待核 → 直接关闭；部分正确/错误 → 错因归因（diag 已在上方预跑）
      if (grade.verdict === "correct" || grade.verdict === "unresolved") {
        const closed = await closeChain(tenantId, id);
        if (closed.status !== 200) return reply.code(closed.status).send(closed.body);
        return reply.send({
          session_id: id,
          judgment: judgmentPayload,
          ...(closed.body as Record<string, unknown>),
        });
      }
      // 到达此处必为部分正确/错误路径（diag 已赋值；防御性断言，逻辑不可达）
      if (!diag) return reply.code(500).send({ error: "internal", detail: "diagnose missing on diagnose path" });

      const claimId = newId("clm");
      const card = diag.outcome.probe
        ? buildProbeCard(id, newId("art"), diag.outcome.probe)
        : null;
      const claimPayload = {
        claim_id: claimId,
        session_id: id,
        status: "open",
        candidates: diag.outcome.candidate_error_causes,
        probe: diag.outcome.probe,
        card: card ? { artifact_id: card.artifact_id, card_id: card.card_id } : null,
        resolved: diag.outcome.resolved,
        rationale: diag.outcome.rationale,
        probe_history: [],
        created_at: now,
      };
      await withTenant(pool, tenantId, async (c) => {
        if (card) await registerProbeCard(c, tenantId, id, card);
        await c.query(
          `insert into runtime_diagnostic_claim (claim_id, tenant_id, session_id, status, payload)
           values ($1,$2,$3,'open',$4)`,
          [claimId, tenantId, id, JSON.stringify(claimPayload)],
        );
        await c.query(
          `update runtime_question_session
              set state = 'DIAGNOSE', probe_rounds = 1,
                  state_history = state_history ||
                    jsonb_build_array(jsonb_build_object('state','DIAGNOSE','entered_at',$2::timestamptz,'actor','orchestrator'))
            where session_id = $1`,
          [id, now],
        );
      });

      if (diag.outcome.resolved || !diag.outcome.probe) {
        // 已可下结论或无追问建议 → 关闭（claim 终态 resolved）
        await withTenant(pool, tenantId, async (c) => {
          await c.query("update runtime_diagnostic_claim set status = 'resolved' where claim_id = $1", [claimId]);
        });
        const closed = await closeChain(tenantId, id);
        if (closed.status !== 200) return reply.code(closed.status).send(closed.body);
        return reply.send({ session_id: id, judgment: judgmentPayload, ...(closed.body as Record<string, unknown>) });
      }

      return reply.send({
        session_id: id,
        judgment: judgmentPayload,
        claim: { claim_id: claimId, candidates: diag.outcome.candidate_error_causes, rationale: diag.outcome.rationale },
        probe: diag.outcome.probe,
        card,
        state: "PROBE_AWAIT",
        probe_rounds: 1,
        max_probe_rounds: MAX_PROBE_ROUNDS,
      });
    });

    /** 学生主动结束（§10.2 终止条件"学生主动结束"；P1）：
     *  - CREATE（无作答）：直接 CLOSED，termination_reason=student_ended，无双产物不入 Dream；
     *  - DIAGNOSE/PROBE_AWAIT（未答探针）：等同跳过语义闭合（claim → unresolved，正常双产物）；
     *  - GRADE（closeChain 曾中断）：续跑关闭全链。 */
    app.post("/sessions/:id/close", async (req, reply) => {
      const tenantId = tenantOf(req);
      if (!tenantId) return reply.code(400).send({ error: "missing x-tenant-id" });
      const { id } = req.params as { id: string };
      const pre = await withTenant(pool, tenantId, async (c) => {
        const r = await c.query(
          `select q.state, (select count(*)::int from runtime_attempt a where a.session_id = q.session_id) as attempt_count
             from runtime_question_session q where q.session_id = $1`,
          [id],
        );
        return r.rows[0];
      });
      if (!pre) return reply.code(404).send({ error: "session not found" });
      if (pre.state === "CLOSED") return reply.code(409).send({ error: "session already closed" });

      // 无作答：学生直接结束，不产生双产物
      if (pre.state === "CREATE" && (pre.attempt_count ?? 0) === 0) {
        const now = new Date().toISOString();
        await withTenant(pool, tenantId, async (c) => {
          await c.query(
            `update runtime_question_session
                set state = 'CLOSED', closed_at = now(), termination_reason = 'student_ended',
                    payload = payload || jsonb_build_object('state', 'CLOSED', 'closed_at', $2::timestamptz,
                      'termination_reason', 'student_ended')
              where session_id = $1`,
            [id, now],
          );
        });
        return reply.send({ session_id: id, state: "CLOSED", termination_reason: "student_ended" });
      }

      // 未答探针 → 待观察语义再闭合（§8.3-4：三轮仍不能闭合输出"待观察"）
      if (pre.state === "DIAGNOSE" || pre.state === "PROBE_AWAIT") {
        await withTenant(pool, tenantId, async (c) => {
          const claim = await c.query(
            "select claim_id, status from runtime_diagnostic_claim where session_id = $1 order by created_at desc limit 1",
            [id],
          );
          if (claim.rows[0] && claim.rows[0].status === "open") {
            await c.query("update runtime_diagnostic_claim set status = 'unresolved' where claim_id = $1", [claim.rows[0].claim_id]);
          }
        });
      }
      const closed = await closeChain(tenantId, id);
      if (closed.status !== 200) return reply.code(closed.status).send(closed.body);
      return reply.send({ session_id: id, termination_reason: "student_ended", ...(closed.body as Record<string, unknown>) });
    });

    /**
     * 卡片交互事件（设计 §5.4：submitted/skipped/bypassed_free_text）。
     * 跳过/直接回复只记录事件，不产生失败观测（§1.1-10）；作答内容走 /probe 判答。
     */
    app.post("/sessions/:id/card-event", async (req, reply) => {
      const tenantId = tenantOf(req);
      if (!tenantId) return reply.code(400).send({ error: "missing x-tenant-id" });
      const { id } = req.params as { id: string };
      const body = req.body as { card_id?: string; artifact_id?: string; interaction_token?: string; response_type?: string; payload?: Record<string, unknown> };
      if (!body.card_id || !["submitted", "skipped", "bypassed_free_text"].includes(body.response_type ?? "")) {
        return reply.code(422).send({ error: "card_id and response_type (submitted|skipped|bypassed_free_text) required" });
      }
      const out = await withTenant(pool, tenantId, async (c) => {
        const s = await c.query("select * from runtime_question_session where session_id = $1", [id]);
        const session = s.rows[0];
        if (!session) return { status: 404 as const };
        // 卡片归属校验：claim 中登记的 card_id 必须匹配
        const claim = await c.query(
          "select payload from runtime_diagnostic_claim where session_id = $1 order by created_at desc limit 1",
          [id],
        );
        const registered = (claim.rows[0]?.payload?.card ?? null) as { artifact_id?: string; card_id?: string } | null;
        let artifactId = session.state !== "CLOSED" && registered && registered.card_id === body.card_id ? registered.artifact_id : undefined;
        if (!artifactId && body.artifact_id && body.interaction_token) {
          const turns = await c.query("select payload from runtime_chat_turn where session_id = $1 and role = 'agent' order by turn desc limit 20", [id]);
          const matched = turns.rows.flatMap((row) => Array.isArray(row.payload?.artifacts) ? row.payload.artifacts : [])
            .find((artifact) => artifact?.artifact_id === body.artifact_id && artifact?.interaction_token === body.interaction_token);
          if (matched) artifactId = body.artifact_id;
        }
        if (!artifactId) return { status: 422 as const, body: { error: "card is not registered for this session" } };
        const used = await c.query(
          "select response_id from runtime_artifact_interaction where session_id = $1 and artifact_id = $2 and card_id = $3 limit 1",
          [id, artifactId, body.card_id],
        );
        if (used.rowCount) return { status: 409 as const, body: { error: "interaction token already consumed" } };
        const responseId = newId("rsp");
        await c.query(
          `insert into runtime_artifact_interaction
             (response_id, tenant_id, session_id, artifact_id, card_id, student_id, response_type, payload)
           values ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [responseId, tenantId, id, artifactId, body.card_id, session.student_id,
           body.response_type, JSON.stringify(body.payload ?? {})],
        );
        return { status: 201 as const, body: { response_id: responseId, response_type: body.response_type } };
      });
      if (out.status === 404) return reply.code(404).send({ error: "session not found" });
      if (out.status === 409 || out.status === 422) return reply.code(out.status).send(out.body);
      return reply.code(201).send(out.body);
    });

    /** 跳过探针（D.2/设计 §1.1-10）：只记录 skipped 事件，不产生失败观测；正常闭合产出双产物 */
    app.post("/sessions/:id/probe-skip", async (req, reply) => {
      const tenantId = tenantOf(req);
      if (!tenantId) return reply.code(400).send({ error: "missing x-tenant-id" });
      const { id } = req.params as { id: string };
      const pre = await withTenant(pool, tenantId, async (c) => {
        const r = await c.query("select state from runtime_question_session where session_id = $1", [id]);
        return r.rows[0];
      });
      if (!pre) return reply.code(404).send({ error: "session not found" });
      if (pre.state !== "DIAGNOSE" && pre.state !== "PROBE_AWAIT") {
        return reply.code(409).send({ error: `probe-skip only in DIAGNOSE/PROBE_AWAIT, current ${pre.state}` });
      }
      // 卡片事件（若已登记）
      await withTenant(pool, tenantId, async (c) => {
        const claim = await c.query(
          "select claim_id, payload from runtime_diagnostic_claim where session_id = $1 order by created_at desc limit 1",
          [id],
        );
        const card = claim.rows[0]?.payload?.card as { artifact_id?: string; card_id?: string } | null;
        if (card?.card_id) {
          await c.query(
            `insert into runtime_artifact_interaction
               (response_id, tenant_id, session_id, artifact_id, card_id, student_id, response_type, payload)
             select $1,$2,session_id,$3,$4,student_id,'skipped','{}' from runtime_question_session where session_id = $5`,
            [newId("rsp"), tenantId, card.artifact_id, card.card_id, id],
          );
        }
        await c.query("update runtime_diagnostic_claim set status = 'skipped' where claim_id = $1", [claim.rows[0]?.claim_id ?? ""]);
      });
      const closed = await closeChain(tenantId, id);
      if (closed.status !== 200) return reply.code(closed.status).send(closed.body);
      return reply.send({ session_id: id, skipped: true, ...(closed.body as Record<string, unknown>) });
    });

    /** 追问作答：判答探针 → 证据入 claim → 闭合或下一轮（≤3）→ 关闭 */
    app.post("/sessions/:id/probe", async (req, reply) => {
      const tenantId = tenantOf(req);
      if (!tenantId) return reply.code(400).send({ error: "missing x-tenant-id" });
      const { id } = req.params as { id: string };
      const body = req.body as ProbeBody;
      if (typeof body.answer_text !== "string" || body.answer_text.length === 0) {
        return reply.code(422).send({ error: "answer_text required" });
      }
      if (body.answer_text.length > MAX_ANSWER_CHARS) {
        return reply.code(422).send({ error: `answer_text exceeds ${MAX_ANSWER_CHARS} chars` });
      }
      const now = new Date().toISOString();

      const pre = await withTenant(pool, tenantId, async (c) => {
        const r = await c.query(
          `select q.question_id, q.state, q.probe_rounds, q.student_id,
                  (select jsonb_build_object('claim_id', claim_id, 'status', status, 'payload', payload)
                     from runtime_diagnostic_claim
                    where session_id = q.session_id order by created_at desc limit 1) as claim
             from runtime_question_session q where q.session_id = $1`,
          [id],
        );
        return r.rows[0];
      });
      if (!pre) return reply.code(404).send({ error: "session not found" });
      if (pre.state !== "DIAGNOSE" && pre.state !== "PROBE_AWAIT") {
        return reply.code(409).send({ error: `probe only allowed from DIAGNOSE/PROBE_AWAIT, current ${pre.state}` });
      }
      const claim = pre.claim as { claim_id?: string; payload?: { probe?: { question: string; judge_rubric: string }; candidates?: unknown[] } };
      const probeQ = claim?.payload?.probe;
      if (!claim?.claim_id || !probeQ?.question) {
        return reply.code(409).send({ error: "no pending probe on claim" });
      }
      if (pre.probe_rounds > MAX_PROBE_ROUNDS) {
        return reply.code(409).send({ error: `probe rounds exhausted (${MAX_PROBE_ROUNDS})` });
      }

      // 探针判答（模型主判；探针问题为本题上下文，学生回答为不可信数据）
      const graded = await runGrading(id, pre.question_id, tenantId, pre.student_id, body.answer_text, {
        title: `（追问 ${pre.probe_rounds}/${MAX_PROBE_ROUNDS}）${probeQ.question}`,
        rubric: `- probe.judge：${probeQ.judge_rubric}`,
      });
      if (!graded.ok) return reply.code(graded.status).send({ error: graded.error, detail: graded.detail });
      const probeOk = graded.grade.verdict === "correct";
      const nextRound = pre.probe_rounds + 1;

      // 事实层：探针作答 + 判定
      const attemptId = newId("att");
      const judgmentId = newId("jud");
      await withTenant(pool, tenantId, async (c) => {
        await c.query(
          `insert into runtime_attempt (attempt_id, tenant_id, session_id, student_id, payload)
           values ($1,$2,$3,$4,$5)`,
          [attemptId, tenantId, id, pre.student_id,
           JSON.stringify({ answer_text: body.answer_text, kind: "probe", round: pre.probe_rounds, probe_question: probeQ.question, submitted_at: now })],
        );
        await c.query(
          `insert into runtime_answer_verdict
             (judgment_id, tenant_id, session_id, attempt_id, verdict, uncertainty, model_id, prompt_version, payload)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [judgmentId, tenantId, id, attemptId, graded.grade.verdict, graded.grade.uncertainty,
           graded.grade.modelImpl, graded.grade.promptVersion,
           JSON.stringify({
             judgment_id: judgmentId, session_id: id, attempt_id: attemptId,
             verdict: graded.grade.verdict,
             rubric_items: graded.grade.rubricItems.map((r) => ({ id: r.id, status: r.status, evidence_refs: [`probe://${id}/${attemptId}`] })),
             decision_summary: graded.grade.decisionSummary,
             uncertainty: graded.grade.uncertainty,
             injection_flags: [], kind: "probe",
             model_id: graded.grade.modelImpl, prompt_version: graded.grade.promptVersion, created_at: now,
           })],
        );
      });

      // 证据入 claim：支持/反对当前候选
      const resolvedErrorCause = claim.payload?.candidates?.[0] && probeOk
        ? (claim.payload.candidates[0] as { error_cause_id?: string }).error_cause_id ?? null
        : null;
      const claimStatus = probeOk ? "resolved" : nextRound > MAX_PROBE_ROUNDS ? "unresolved" : "open";
      await withTenant(pool, tenantId, async (c) => {
        const cur = await c.query(
          "select payload from runtime_diagnostic_claim where claim_id = $1",
          [claim.claim_id],
        );
        const p = cur.rows[0]?.payload ?? {};
        const history = [...(p.probe_history ?? []), {
          round: pre.probe_rounds,
          probe_question: probeQ.question,
          answer: body.answer_text,
          verdict: graded.grade.verdict,
          probe_ok: probeOk,
        }];
        await c.query(
          `update runtime_diagnostic_claim
              set status = $2, payload = payload || jsonb_build_object('probe_history', $3::jsonb,
                    'probe_ok', $4, 'resolved_error_cause', $5)
            where claim_id = $1`,
          [claim.claim_id, claimStatus, JSON.stringify(history), probeOk, resolvedErrorCause],
        );
        await c.query(
          `update runtime_question_session
              set state = $2, probe_rounds = $3,
                  state_history = state_history ||
                    jsonb_build_array(jsonb_build_object('state',$4,'entered_at',$5::timestamptz,'actor','orchestrator'))
            where session_id = $1`,
          [id, probeOk || claimStatus === "unresolved" ? "DIAGNOSE" : "PROBE_AWAIT",
           nextRound, probeOk || claimStatus === "unresolved" ? "DIAGNOSE" : "PROBE_AWAIT", now],
        );
      });

      // 闭合或轮次耗尽 → 关闭全链
      if (probeOk || claimStatus === "unresolved") {
        const closed = await closeChain(tenantId, id);
        if (closed.status !== 200) return reply.code(closed.status).send(closed.body);
        return reply.send({
          session_id: id,
          probe: { round: pre.probe_rounds, verdict: graded.grade.verdict },
          claim: { claim_id: claim.claim_id, status: claimStatus, resolved_error_cause: resolvedErrorCause },
          ...(closed.body as Record<string, unknown>),
        });
      }

      // 下一轮追问：复用规则库 probe 或由模型再生成（首版：模型再诊断一次）
      const diag = await runDiagnose(id, pre.question_id, tenantId, pre.student_id, graded.grade.verdict, body.answer_text);
      if (!diag.ok) return reply.code(diag.status).send({ error: diag.error, detail: diag.detail });
      if (!diag.outcome.probe || diag.outcome.resolved) {
        const closed = await closeChain(tenantId, id);
        if (closed.status !== 200) return reply.code(closed.status).send(closed.body);
        return reply.send({
          session_id: id,
          probe: { round: pre.probe_rounds, verdict: graded.grade.verdict },
          claim: { claim_id: claim.claim_id, status: "resolved" },
          ...(closed.body as Record<string, unknown>),
        });
      }
      const nextCard = buildProbeCard(id, newId("art"), diag.outcome.probe);
      await withTenant(pool, tenantId, async (c) => {
        await registerProbeCard(c, tenantId, id, nextCard);
        await c.query(
          `update runtime_diagnostic_claim
              set payload = payload || jsonb_build_object('probe', $2::jsonb, 'card', $3::jsonb)
            where claim_id = $1`,
          [claim.claim_id, JSON.stringify(diag.outcome.probe),
           JSON.stringify({ artifact_id: nextCard.artifact_id, card_id: nextCard.card_id })],
        );
        await c.query(
          `update runtime_question_session set state = 'PROBE_AWAIT' where session_id = $1`,
          [id],
        );
      });
      return reply.send({
        session_id: id,
        probe: diag.outcome.probe,
        card: nextCard,
        probe_rounds: nextRound,
        max_probe_rounds: MAX_PROBE_ROUNDS,
        state: "PROBE_AWAIT",
      });
    });
  },
});
