import type pg from "pg";
import {
  finiteNumber,
  jsonObject,
  newId,
  nullableString,
  stringArray,
  stringValue,
  type Principal,
  withPrincipal,
} from "./lib.ts";

type Json = Record<string, unknown>;
type Phase = "ktq" | "er";
type EntityKind = "knowledge" | "question_type" | "question" | "error_cause" | "diagnosis_rule";
type SourceObjectInput = { workspacePath: string; objectId: string; versionId: string; sha256: string };
type VerifiedSourceObject = SourceObjectInput & { mimeType: string };

export interface CandidateInput {
  phase: Phase;
  threadId: string;
  toolCallId: string;
  resultSha256: string;
  resultObjectId: string;
  receiptObjectId: string;
  sourceObjects: SourceObjectInput[];
  result: Json;
  inputCandidateSetId?: string | null;
  supersedesCandidateSetId?: string | null;
  modelId?: string | null;
  promptVersion?: string | null;
}

export interface CandidateSummary {
  candidate_set_id: string;
  phase: Phase;
  owner_teacher_user_id: string;
  thread_id: string;
  sequence_no: number;
  status: string;
  item_count: number;
  display_name: string | null;
  created_at: string;
  decided_at: string | null;
}

interface RevisionRef {
  revisionId: string;
  entityId: string;
  kind: EntityKind;
  created: boolean;
}

const ID_PATTERNS: Record<EntityKind, RegExp> = {
  knowledge: /^K_[A-Za-z0-9_.:-]{1,127}$/,
  question_type: /^T_[A-Za-z0-9_.:-]{1,127}$/,
  question: /^Q_[A-Za-z0-9_.:-]{1,127}$/,
  error_cause: /^E_[A-Za-z0-9_.:-]{1,127}$/,
  diagnosis_rule: /^R_[A-Za-z0-9_.:-]{1,127}$/,
};

const REVIEW_FIELDS: Record<EntityKind, ReadonlySet<string>> = {
  knowledge: new Set(["name", "description", "grade_band", "difficulty", "mastery_standard", "remediation_advice"]),
  question_type: new Set(["name", "description", "identifying_features", "standard_method"]),
  question: new Set(["chapter_id", "module_2", "module_3", "stem_format", "stem_markdown", "difficulty", "question_type_revision_id", "analysis_markdown"]),
  error_cause: new Set(["category", "name", "description", "manifestation", "judgment_basis", "remediation"]),
  diagnosis_rule: new Set(["rule_version", "trigger_text", "probe_text"]),
};

const kindForId = (value: string): EntityKind | null => {
  if (value.startsWith("K_")) return "knowledge";
  if (value.startsWith("T_")) return "question_type";
  if (value.startsWith("Q_")) return "question";
  if (value.startsWith("E_")) return "error_cause";
  if (value.startsWith("R_")) return "diagnosis_rule";
  return null;
};

const asJson = (value: unknown): Json => jsonObject(value);

/** 从问题关联知识点的 description（"一级 / 二级 / 三级"）解析模块归属路径。
 *  优先取需求维度中 role=primary 的知识点；取不到时回退到首个知识点；均无则用题干自带章节名。 */
function modulePathOfQuestion(raw: Json): [string | null, string | null, string | null] {
  const knowledge = (Array.isArray(raw.knowledge_components) ? raw.knowledge_components : []).map(asJson);
  if (!knowledge.length) {
    const chapter = stringValue(raw.chapter_id);
    return [chapter || null, null, null];
  }
  const targets = Array.isArray(raw.measurement_targets) ? raw.measurement_targets.map(asJson) : [];
  const primaryDim = targets.find((target) => stringValue(target.role, "primary") === "primary");
  const picked = primaryDim
    ? knowledge.find((item) => stringValue(item.id) === stringValue(primaryDim.dim))
    ?? knowledge[0]
    : knowledge[0];
  const description = stringValue(picked?.description);
  const parts = description.split("/").map((part) => part.trim()).filter(Boolean);
  if (parts.length >= 3) return [parts[0] ?? null, parts[1] ?? null, parts[2] ?? null];
  if (parts.length === 2) return [parts[0] ?? null, parts[1] ?? null, null];
  if (parts.length === 1) return [parts[0] ?? null, null, null];
  const chapter = stringValue(raw.chapter_id);
  return [chapter || null, null, null];
}

function sourceLocator(question: Json): string | null {
  const source = asJson(question.source);
  const path = stringValue(source.path);
  const page = source.page;
  if (!path && !Number.isSafeInteger(page)) return null;
  return JSON.stringify({
    path: path || null,
    page: Number.isSafeInteger(page) ? page : null,
    bbox: Array.isArray(source.bbox) ? source.bbox : null,
  });
}

const normalizeWorkspaceReference = (value: string): string => {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  return normalized.startsWith("input/") ? normalized : `input/${normalized}`;
};

function requireId(value: unknown, kind: EntityKind): string {
  const id = stringValue(value);
  if (!ID_PATTERNS[kind].test(id)) throw new Error(`invalid ${kind} entity id`);
  return id;
}

async function assertTeacher(client: pg.PoolClient, principal: Principal): Promise<void> {
  const role = await client.query<{ role: string }>(
    `select role from identity_user_role where tenant_id=$1 and user_id=$2 and role='teacher'`,
    [principal.tenantId, principal.userId],
  );
  if (!role.rows.length) throw new Error("teacher role required");
}

async function ensureVisibleRevision(
  client: pg.PoolClient,
  principal: Principal,
  entityId: string,
  expectedKind?: EntityKind,
): Promise<RevisionRef> {
  const row = await client.query<{ entity_id: string; entity_kind: EntityKind; origin: string; owner_teacher_user_id: string | null }>(
    `select entity_id,entity_kind,origin,owner_teacher_user_id
       from content_entity where tenant_id=$1 and entity_id=$2`,
    [principal.tenantId, entityId],
  );
  const entity = row.rows[0];
  if (!entity) throw new Error(`referenced entity ${entityId} was not found`);
  if (expectedKind && entity.entity_kind !== expectedKind) throw new Error(`entity ${entityId} has the wrong kind`);
  if (entity.origin === "teacher" && entity.owner_teacher_user_id !== principal.userId) {
    throw new Error(`entity ${entityId} is owned by another teacher`);
  }
  const revision = await client.query<{ revision_id: string }>(
    `select revision_id from content_entity_revision
      where tenant_id=$1 and entity_id=$2 and lifecycle_status in ('approved','ready')
      order by revision_no desc limit 1`,
    [principal.tenantId, entityId],
  );
  if (!revision.rows[0]) throw new Error(`entity ${entityId} has no usable revision`);
  return { revisionId: revision.rows[0].revision_id, entityId, kind: entity.entity_kind, created: false };
}

async function insertLineage(
  client: pg.PoolClient,
  principal: Principal,
  values: {
    entityId: string;
    entityType: EntityKind;
    revisionId: string;
    fieldName: string;
    threadId: string;
    toolCallId: string;
    sourceLocator?: string | null;
    sourceObjectId?: string | null;
  },
): Promise<void> {
  const fromSource = Boolean(values.sourceObjectId || values.sourceLocator);
  await client.query(
    `insert into content_field_provenance
       (tenant_id,revision_id,field_name,thread_id,tool_call_id,source_locator,source_object_id,
        derivation_type,provenance_status,review_decision)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending')`,
    [principal.tenantId, values.revisionId, values.fieldName, values.threadId,
      values.toolCallId, values.sourceLocator ?? null, values.sourceObjectId ?? null,
      fromSource ? "source_extract" : "model_generation",
      fromSource ? "derived" : "model_generated"],
  );
}

async function insertRevision(
  client: pg.PoolClient,
  principal: Principal,
  candidateSetId: string,
  threadId: string,
  toolCallId: string,
  kind: EntityKind,
  entityId: string,
  data: Json,
  modelId: string | null | undefined,
  promptVersion: string | null | undefined,
  forceRevision = false,
): Promise<RevisionRef> {
  const current = await client.query<{ revision_id: string; entity_kind: EntityKind }>(
    `select r.revision_id,e.entity_kind
       from content_entity_revision r
       join content_entity e on e.entity_id=r.entity_id
      where r.tenant_id=$1 and r.candidate_set_id=$2 and r.entity_id=$3
      order by r.revision_no desc limit 1`,
    [principal.tenantId, candidateSetId, entityId],
  );
  if (current.rows[0]) {
    if (current.rows[0].entity_kind !== kind) throw new Error(`entity ${entityId} has the wrong kind`);
    return { revisionId: current.rows[0].revision_id, entityId, kind, created: false };
  }

  const existing = await client.query<{ entity_id: string; entity_kind: EntityKind; origin: string; owner_teacher_user_id: string | null }>(
    `select entity_id,entity_kind,origin,owner_teacher_user_id from content_entity where tenant_id=$1 and entity_id=$2`,
    [principal.tenantId, entityId],
  );
  const entity = existing.rows[0];
  if (entity) {
    if (entity.entity_kind !== kind) throw new Error(`entity ${entityId} has the wrong kind`);
    const mayCreateRevision = forceRevision
      && entity.origin === "teacher"
      && entity.owner_teacher_user_id === principal.userId;
    if (!mayCreateRevision) return ensureVisibleRevision(client, principal, entityId, kind);
  }

  if (!entity) {
    await client.query(
      `insert into content_entity(entity_id,tenant_id,entity_kind,origin,owner_teacher_user_id,created_by_user_id)
       values ($1,$2,$3,'teacher',$4,$4)`,
      [entityId, principal.tenantId, kind, principal.userId],
    );
  }
  await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [entityId]);
  const next = await client.query<{ revision_no: number }>(
    `select coalesce(max(revision_no),0)+1 as revision_no from content_entity_revision where entity_id=$1`,
    [entityId],
  );
  const revisionNo = Number(next.rows[0]?.revision_no ?? 1);
  const revisionId = newId("rev");
  await client.query(
    `insert into content_entity_revision
       (revision_id,entity_id,tenant_id,revision_no,candidate_set_id,lifecycle_status,created_by_thread_id,model_id,prompt_version)
     values ($1,$2,$3,$4,$5,'candidate',$6,$7,$8)`,
    [revisionId, entityId, principal.tenantId, revisionNo, candidateSetId, threadId, modelId ?? null, promptVersion ?? null],
  );

  if (kind === "knowledge") {
    await client.query(
      `insert into content_knowledge_revision(revision_id,tenant_id,name,description,grade_band,difficulty,mastery_standard,remediation_advice)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [revisionId, principal.tenantId, stringValue(data.name, entityId), stringValue(data.description),
        stringValue(data.grade_band) || null, finiteNumber(data.difficulty, 0.5),
        stringValue(data.mastery_standard) || null, stringValue(data.remediation_advice) || null],
    );
  } else if (kind === "question_type") {
    await client.query(
      `insert into content_question_type_revision(revision_id,tenant_id,name,description,identifying_features,standard_method)
       values ($1,$2,$3,$4,$5,$6)`,
      [revisionId, principal.tenantId, stringValue(data.name, entityId), stringValue(data.description),
        stringValue(data.identifying_features), stringValue(data.standard_method)],
    );
  } else if (kind === "question") {
    await client.query(
      `insert into content_question_revision(revision_id,tenant_id,chapter_id,module_2,module_3,stem_format,stem_markdown,difficulty,question_type_revision_id,analysis_markdown)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [revisionId, principal.tenantId, stringValue(data.chapter_id, "unclassified"), nullableString(data.module_2), nullableString(data.module_3),
        stringValue(data.stem_format, "open_solution"), stringValue(data.stem_markdown), finiteNumber(data.difficulty, 0.5),
        stringValue(data.question_type_revision_id) || null, stringValue(data.analysis_markdown)],
    );
  } else if (kind === "error_cause") {
    await client.query(
      `insert into content_error_cause_revision(revision_id,tenant_id,category,name,description,manifestation,judgment_basis,remediation)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [revisionId, principal.tenantId, stringValue(data.category), stringValue(data.name, entityId), stringValue(data.description, ""),
        stringValue(data.manifestation), stringValue(data.judgment_basis), stringValue(data.remediation)],
    );
  } else {
    await client.query(
      `insert into content_diagnosis_rule_revision(revision_id,tenant_id,rule_version,trigger_text,probe_text)
       values ($1,$2,$3,$4,$5)`,
      [revisionId, principal.tenantId, stringValue(data.rule_version, "1"), stringValue(data.trigger), stringValue(data.probe)],
    );
  }
  return { revisionId, entityId, kind, created: true };
}

async function addItem(
  client: pg.PoolClient,
  principal: Principal,
  revisionId: string,
  itemKind: string,
  position: number,
): Promise<string> {
  const itemId = newId("item");
  await client.query(
    `insert into content_revision_item(item_id,revision_id,tenant_id,item_kind,position) values ($1,$2,$3,$4,$5)`,
    [itemId, revisionId, principal.tenantId, itemKind, position],
  );
  return itemId;
}

async function attachCandidateRefs(
  client: pg.PoolClient,
  principal: Principal,
  candidateSetId: string,
  refs: RevisionRef[],
): Promise<void> {
  const unique = [...new Map(refs.map((ref) => [ref.revisionId, ref])).values()];
  if (!unique.length) return;
  await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [`candidate-items:${candidateSetId}`]);
  const current = await client.query<{ revision_id: string }>(
    `select revision_id from content_candidate_set_item where tenant_id=$1 and candidate_set_id=$2`,
    [principal.tenantId, candidateSetId],
  );
  const seen = new Set(current.rows.map((row) => row.revision_id));
  const next = await client.query<{ item_order: number }>(
    `select coalesce(max(item_order),-1)+1 as item_order from content_candidate_set_item where tenant_id=$1 and candidate_set_id=$2`,
    [principal.tenantId, candidateSetId],
  );
  let order = Number(next.rows[0]?.item_order ?? 0);
  for (const ref of unique) {
    if (seen.has(ref.revisionId)) continue;
    await client.query(
      `insert into content_candidate_set_item(tenant_id,candidate_set_id,revision_id,item_order) values ($1,$2,$3,$4) on conflict do nothing`,
      [principal.tenantId, candidateSetId, ref.revisionId, order],
    );
    seen.add(ref.revisionId);
    order += 1;
  }
}

async function addKtqQuestion(
  client: pg.PoolClient,
  principal: Principal,
  candidateSetId: string,
  threadId: string,
  toolCallId: string,
  raw: Json,
  modelId: string | null | undefined,
  promptVersion: string | null | undefined,
  forceRevision: boolean,
  sourceObjects: ReadonlyMap<string, VerifiedSourceObject>,
): Promise<RevisionRef[]> {
  const refs: RevisionRef[] = [];
  const source = sourceLocator(raw);
  const sourcePath = stringValue(asJson(raw.source).path);
  const sourceObject = sourcePath ? sourceObjects.get(normalizeWorkspaceReference(sourcePath)) : undefined;
  if (sourcePath && !sourceObject) throw new Error(`source file is not backed by a verified object: ${sourcePath}`);
  const knowledgeRefs = new Map<string, RevisionRef>();
  for (const entry of Array.isArray(raw.knowledge_components) ? raw.knowledge_components : []) {
    const item = asJson(entry);
    const id = requireId(item.id, "knowledge");
    const ref = await insertRevision(client, principal, candidateSetId, threadId, toolCallId, "knowledge", id, item, modelId, promptVersion, forceRevision);
    knowledgeRefs.set(id, ref);
    refs.push(ref);
    if (ref.created) {
      for (const fieldName of REVIEW_FIELDS.knowledge) {
        if (item[fieldName] !== undefined) await insertLineage(client, principal, { entityId: id, entityType: "knowledge", revisionId: ref.revisionId, fieldName, threadId, toolCallId, sourceLocator: source, sourceObjectId: sourceObject?.objectId ?? null });
      }
    }
  }
  const type = asJson(raw.question_type);
  const typeId = requireId(type.id, "question_type");
  const typeRef = await insertRevision(client, principal, candidateSetId, threadId, toolCallId, "question_type", typeId, type, modelId, promptVersion, forceRevision);
  refs.push(typeRef);
  if (typeRef.created) {
    for (const fieldName of REVIEW_FIELDS.question_type) {
      if (type[fieldName] !== undefined) await insertLineage(client, principal, { entityId: typeId, entityType: "question_type", revisionId: typeRef.revisionId, fieldName, threadId, toolCallId, sourceLocator: source, sourceObjectId: sourceObject?.objectId ?? null });
    }
  }

  const questionId = requireId(raw.question_id ?? newId("Q"), "question");
  const modulePath = modulePathOfQuestion(raw);
  const questionData: Json = {
    chapter_id: stringValue(raw.chapter_id, modulePath[0] ?? "unclassified"),
    module_2: modulePath[1] ?? null,
    module_3: modulePath[2] ?? null,
    stem_format: stringValue(raw.stem_format, "open_solution"),
    stem_markdown: stringValue(raw.stem_markdown),
    difficulty: finiteNumber(raw.difficulty),
    question_type_revision_id: typeRef.revisionId,
    analysis_markdown: stringValue(raw.analysis_markdown ?? raw.explanation),
  };
  const questionRef = await insertRevision(client, principal, candidateSetId, threadId, toolCallId, "question", questionId, questionData, modelId, promptVersion, forceRevision);
  refs.push(questionRef);
  if (!questionRef.created) {
    await attachCandidateRefs(client, principal, candidateSetId, refs);
    return refs;
  }

  for (const [fieldName, value] of Object.entries(questionData)) {
    await insertLineage(client, principal, { entityId: questionId, entityType: "question", revisionId: questionRef.revisionId, fieldName, threadId, toolCallId, sourceLocator: source, sourceObjectId: sourceObject?.objectId ?? null });
  }

  const options = Array.isArray(raw.options) ? raw.options : [];
  for (const [position, option] of options.entries()) {
    const item = asJson(option);
    const itemId = await addItem(client, principal, questionRef.revisionId, "question_option", position);
    await client.query(
      `insert into content_question_option(item_id,tenant_id,option_key,option_text,is_correct) values ($1,$2,$3,$4,$5)`,
      [itemId, principal.tenantId, stringValue(item.key, String.fromCharCode(65 + position)), stringValue(item.text_markdown ?? item.text), Boolean(item.is_correct)],
    );
  }
  const answer = asJson(raw.answer);
  if (Object.keys(answer).length) {
    const itemId = await addItem(client, principal, questionRef.revisionId, "question_answer", 0);
    await client.query(
      `insert into content_question_answer_item(item_id,tenant_id,answer_text,equivalence_rule) values ($1,$2,$3,$4)`,
      [itemId, principal.tenantId, JSON.stringify(answer), stringValue(answer.equivalence_rule) || null],
    );
  }
  const rubric = Array.isArray(raw.rubric) ? raw.rubric : [];
  for (const [position, value] of rubric.entries()) {
    const item = asJson(value);
    const itemId = await addItem(client, principal, questionRef.revisionId, "question_rubric", position);
    await client.query(
      `insert into content_question_rubric_item(item_id,tenant_id,criterion,score) values ($1,$2,$3,$4)`,
      [itemId, principal.tenantId, stringValue(item.description ?? item.criterion, `评分点 ${position + 1}`), typeof item.score === "number" ? item.score : null],
    );
  }
  const targets = Array.isArray(raw.measurement_targets) ? raw.measurement_targets : [];
  for (const [position, value] of targets.entries()) {
    const target = asJson(value);
    const dim = stringValue(target.dim);
    const dimRef = knowledgeRefs.get(dim) ?? (dim === typeId ? typeRef : undefined);
    if (!dimRef) throw new Error(`measurement target ${dim} is not declared by this question`);
    const itemId = await addItem(client, principal, questionRef.revisionId, "question_measurement_target", position);
    await client.query(
      `insert into content_question_measurement_target(item_id,tenant_id,dimension_revision_id,target_role,evidence_rule) values ($1,$2,$3,$4,$5)`,
      [itemId, principal.tenantId, dimRef.revisionId, stringValue(target.role, "primary"), stringValue(target.evidence_rule)],
    );
  }
  const imageRefs = stringArray(raw.image_refs);
  for (const [position, imageRef] of imageRefs.entries()) {
    const imageObject = sourceObjects.get(normalizeWorkspaceReference(imageRef));
    if (!imageObject) throw new Error(`question image is not backed by a verified object: ${imageRef}`);
    const itemId = await addItem(client, principal, questionRef.revisionId, "question_asset", position);
    await client.query(
      `insert into content_question_asset_revision
         (item_id,tenant_id,storage_object_id,asset_role,source_locator,mime_type,content_sha256)
       values ($1,$2,$3,'image',$4,$5,$6)`,
      [itemId, principal.tenantId, imageObject?.objectId ?? null, imageRef, imageObject?.mimeType ?? "application/octet-stream", imageObject?.sha256 ?? null],
    );
  }
  await attachCandidateRefs(client, principal, candidateSetId, refs);
  return refs;
}

async function addErEntities(
  client: pg.PoolClient,
  principal: Principal,
  candidateSetId: string,
  threadId: string,
  toolCallId: string,
  result: Json,
  modelId: string | null | undefined,
  promptVersion: string | null | undefined,
  forceRevision: boolean,
): Promise<RevisionRef[]> {
  const refs: RevisionRef[] = [];
  const errors = new Map<string, RevisionRef>();
  const reusedErrors = Array.isArray(result.reused_error_causes) ? result.reused_error_causes : [];
  for (const value of reusedErrors) {
    const id = stringValue(asJson(value).id || value);
    const ref = await ensureVisibleRevision(client, principal, requireId(id, "error_cause"), "error_cause");
    errors.set(id, ref);
    refs.push(ref);
  }
  const reusedRules = Array.isArray(result.reused_rules) ? result.reused_rules : [];
  for (const value of reusedRules) {
    const id = stringValue(asJson(value).id || value);
    const ref = await ensureVisibleRevision(client, principal, requireId(id, "diagnosis_rule"), "diagnosis_rule");
    refs.push(ref);
  }
  for (const value of Array.isArray(result.error_causes) ? result.error_causes : []) {
    const item = asJson(value);
    const id = requireId(item.id, "error_cause");
    const ref = await insertRevision(client, principal, candidateSetId, threadId, toolCallId, "error_cause", id, item, modelId, promptVersion, forceRevision);
    errors.set(id, ref);
    refs.push(ref);
    if (ref.created) {
      for (const fieldName of REVIEW_FIELDS.error_cause) {
        if (item[fieldName] !== undefined) await insertLineage(client, principal, { entityId: id, entityType: "error_cause", revisionId: ref.revisionId, fieldName, threadId, toolCallId });
      }
    }
  }
  const frozen = Array.isArray(result.frozen_dimensions) ? stringArray(result.frozen_dimensions) : [];
  for (const value of Array.isArray(result.diagnosis_rules) ? result.diagnosis_rules : []) {
    const item = asJson(value);
    const id = requireId(item.id, "diagnosis_rule");
    const ref = await insertRevision(client, principal, candidateSetId, threadId, toolCallId, "diagnosis_rule", id, item, modelId, promptVersion, forceRevision);
    if (!ref.created) {
      refs.push(ref);
      continue;
    }
    refs.push(ref);
    for (const fieldName of REVIEW_FIELDS.diagnosis_rule) {
      if (item[fieldName] !== undefined || (fieldName === "trigger_text" && item.trigger !== undefined) || (fieldName === "probe_text" && item.probe !== undefined)) {
        await insertLineage(client, principal, { entityId: id, entityType: "diagnosis_rule", revisionId: ref.revisionId, fieldName, threadId, toolCallId });
      }
    }
    const dimensionIds = stringArray(item.dimension_ids);
    const errorsForRule = stringArray(item.candidate_error_causes);
    for (const [position, errorId] of errorsForRule.entries()) {
      const errorRef = errors.get(errorId) ?? await ensureVisibleRevision(client, principal, requireId(errorId, "error_cause"), "error_cause");
      const itemId = await addItem(client, principal, ref.revisionId, "diagnosis_rule_error_cause", position);
      await client.query(
        `insert into content_diagnosis_rule_error_cause(item_id,tenant_id,error_cause_revision_id) values ($1,$2,$3)`,
        [itemId, principal.tenantId, errorRef.revisionId],
      );
    }
    for (const [position, dim] of dimensionIds.entries()) {
      if (frozen.length && !frozen.includes(dim)) throw new Error(`diagnosis rule ${id} uses a dimension outside frozen KTQ`);
      const dimRef = await ensureVisibleRevision(client, principal, requireId(dim, kindForId(dim) ?? "knowledge"));
      const itemId = await addItem(client, principal, ref.revisionId, "diagnosis_rule_dimension", position);
      await client.query(
        `insert into content_diagnosis_rule_dimension(item_id,tenant_id,dimension_revision_id) values ($1,$2,$3)`,
        [itemId, principal.tenantId, dimRef.revisionId],
      );
    }
    const citations = Array.isArray(item.citations) ? item.citations : [];
    for (const [position, citation] of citations.entries()) {
      const c = asJson(citation);
      const itemId = await addItem(client, principal, ref.revisionId, "diagnosis_rule_citation", position);
      await client.query(
        `insert into content_diagnosis_rule_citation(item_id,tenant_id,source_excerpt_id,claim_text) values ($1,$2,null,$3)`,
        [itemId, principal.tenantId, JSON.stringify(c)],
      );
    }
  }
  await attachCandidateRefs(client, principal, candidateSetId, refs);
  return refs;
}

export class CandidateRepository {
  constructor(private readonly pool: pg.Pool) {}

  async register(principal: Principal, input: CandidateInput): Promise<CandidateSummary> {
    if (!/^[0-9a-f]{64}$/.test(input.resultSha256)) throw new Error("result_sha256 must be 64 lowercase hex characters");
    if (!input.threadId || !input.toolCallId) throw new Error("thread_id and tool_call_id are required");
    return withPrincipal(this.pool, principal, async (client) => {
      await assertTeacher(client, principal);
      const duplicate = await client.query<CandidateSummary>(
        `select candidate_set_id,phase,owner_teacher_user_id,thread_id,sequence_no,status,display_name,created_at,decided_at,
                (select count(*)::int from content_candidate_set_item i where i.candidate_set_id=s.candidate_set_id) as item_count
           from content_candidate_set s
          where tenant_id=$1 and thread_id=$2 and phase=$3 and respond_tool_call_id=$4`,
        [principal.tenantId, input.threadId, input.phase, input.toolCallId],
      );
      if (duplicate.rows[0]) return this.mapSummary(duplicate.rows[0]);
      await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [`${principal.tenantId}:${input.threadId}:${input.phase}`]);
      if (input.resultObjectId === input.receiptObjectId) throw new Error("result and receipt must use distinct audit objects");
      const auditObjects = await client.query<{
        object_id: string;
        purpose: string;
        state: string;
        sha256: string | null;
        version_id: string | null;
        mime_type: string;
      }>(
        `select object_id,purpose,state,sha256,version_id,mime_type
           from storage_object
          where tenant_id=$1 and owner_user_id=$2 and object_id=any($3::text[])`,
        [principal.tenantId, principal.userId, [input.resultObjectId, input.receiptObjectId]],
      );
      if (auditObjects.rows.length !== 2 || auditObjects.rows.some((row) => row.purpose !== "candidate" || row.state !== "ready" || !row.version_id || row.mime_type !== "application/json")) {
        throw new Error("candidate audit objects are missing, unverified or not owned by this teacher");
      }
      const resultAudit = auditObjects.rows.find((row) => row.object_id === input.resultObjectId);
      if (!resultAudit || resultAudit.sha256 !== input.resultSha256) throw new Error("candidate result object hash does not match result_sha256");
      if (input.sourceObjects.length > 64) throw new Error("too many candidate source objects");
      const sourceObjectIds = [...new Set(input.sourceObjects.map((sourceObject) => sourceObject.objectId))];
      const sourceRows = sourceObjectIds.length
        ? await client.query<{ object_id: string; state: string; sha256: string | null; version_id: string | null; mime_type: string }>(
          `select object_id,state,sha256,version_id,mime_type
             from storage_object
            where tenant_id=$1 and owner_user_id=$2 and object_id=any($3::text[])`,
          [principal.tenantId, principal.userId, sourceObjectIds],
        )
        : { rows: [] as Array<{ object_id: string; state: string; sha256: string | null; version_id: string | null; mime_type: string }> };
      if (sourceRows.rows.length !== sourceObjectIds.length) throw new Error("candidate source object is missing or not owned by this teacher");
      const sourceRowsById = new Map(sourceRows.rows.map((row) => [row.object_id, row]));
      const verifiedSources = new Map<string, VerifiedSourceObject>();
      for (const sourceObject of input.sourceObjects) {
        const workspacePath = normalizeWorkspaceReference(sourceObject.workspacePath);
        if (!/^input\/original\/[^/\\\u0000]+$/.test(workspacePath) || verifiedSources.has(workspacePath)) throw new Error("candidate source workspace path is invalid or duplicated");
        const row = sourceRowsById.get(sourceObject.objectId);
        if (!row || row.state !== "ready" || row.version_id !== sourceObject.versionId || row.sha256 !== sourceObject.sha256) throw new Error("candidate source object version or hash does not match storage");
        verifiedSources.set(workspacePath, { ...sourceObject, workspacePath, mimeType: row.mime_type });
      }
      const sequence = await client.query<{ sequence_no: number }>(
        `select coalesce(max(sequence_no),0)+1 as sequence_no from content_candidate_set where tenant_id=$1 and thread_id=$2 and phase=$3`,
        [principal.tenantId, input.threadId, input.phase],
      );
      const candidateSetId = newId("cset");
      await client.query(
        `insert into content_candidate_set
          (candidate_set_id,tenant_id,phase,owner_teacher_user_id,thread_id,sequence_no,input_candidate_set_id,
           supersedes_candidate_set_id,result_object_id,receipt_object_id,result_sha256,respond_tool_call_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [candidateSetId, principal.tenantId, input.phase, principal.userId, input.threadId, Number(sequence.rows[0]?.sequence_no ?? 1),
          input.inputCandidateSetId ?? null, input.supersedesCandidateSetId ?? null, input.resultObjectId ?? null,
          input.receiptObjectId ?? null, input.resultSha256, input.toolCallId],
      );
      if (input.phase === "ktq") {
        const questions = Array.isArray(input.result.questions) ? input.result.questions : [];
        if (!questions.length) throw new Error("KTQ result has no questions");
        for (const question of questions) {
          await addKtqQuestion(
            client,
            principal,
            candidateSetId,
            input.threadId,
            input.toolCallId,
            asJson(question),
            input.modelId,
            input.promptVersion,
            Boolean(input.supersedesCandidateSetId),
            verifiedSources,
          );
        }
      } else {
        if (!input.inputCandidateSetId) throw new Error("ER result requires an approved KTQ candidate");
        const inputStatus = await client.query<{ status: string; phase: Phase; owner_teacher_user_id: string }>(
          `select status,phase,owner_teacher_user_id from content_candidate_set where candidate_set_id=$1 and tenant_id=$2`,
          [input.inputCandidateSetId, principal.tenantId],
        );
        const source = inputStatus.rows[0];
        if (!source || source.phase !== "ktq" || source.status !== "approved" || source.owner_teacher_user_id !== principal.userId) throw new Error("ER input must be an approved KTQ candidate owned by this teacher");
        const refs = await addErEntities(
          client,
          principal,
          candidateSetId,
          input.threadId,
          input.toolCallId,
          input.result,
          input.modelId,
          input.promptVersion,
          Boolean(input.supersedesCandidateSetId),
        );
        if (!refs.length) throw new Error("ER result has no reusable or new entities");
      }
      if (input.supersedesCandidateSetId) {
        await client.query(
          `update content_entity_revision set lifecycle_status='superseded'
            where candidate_set_id=$1 and tenant_id=$2 and lifecycle_status='candidate'`,
          [input.supersedesCandidateSetId, principal.tenantId],
        );
        await client.query(
          `update content_candidate_set set status='superseded',decided_at=coalesce(decided_at,now())
             where candidate_set_id=$1 and tenant_id=$2 and owner_teacher_user_id=$3`,
          [input.supersedesCandidateSetId, principal.tenantId, principal.userId],
        );
      }
      const result = await client.query<CandidateSummary>(
        `select candidate_set_id,phase,owner_teacher_user_id,thread_id,sequence_no,status,display_name,created_at,decided_at,
                (select count(*)::int from content_candidate_set_item i where i.candidate_set_id=s.candidate_set_id) as item_count
           from content_candidate_set s where candidate_set_id=$1`,
        [candidateSetId],
      );
      if (!result.rows[0]) throw new Error("candidate registration returned no row");
      return this.mapSummary(result.rows[0]);
    });
  }

  async get(principal: Principal, candidateSetId: string): Promise<Json | null> {
    return withPrincipal(this.pool, principal, async (client) => {
      const candidate = await client.query<CandidateSummary & { result_sha256: string | null; input_candidate_set_id: string | null; supersedes_candidate_set_id: string | null; respond_tool_call_id: string }>(
        `select s.*, (select count(*)::int from content_candidate_set_item i where i.candidate_set_id=s.candidate_set_id) as item_count
           from content_candidate_set s
          where s.tenant_id=$1 and s.candidate_set_id=$2 and s.owner_teacher_user_id=$3`,
        [principal.tenantId, candidateSetId, principal.userId],
      );
      const row = candidate.rows[0];
      if (!row) return null;
      const items = await client.query(
        `select i.item_order,e.entity_id,e.entity_kind,r.revision_id,r.revision_no,r.lifecycle_status,
                kr.name as knowledge_name,kr.description as knowledge_description,
                kr.grade_band as knowledge_grade_band,kr.difficulty as knowledge_difficulty,
                kr.mastery_standard as knowledge_mastery_standard,kr.remediation_advice as knowledge_remediation_advice,
                tr.name as question_type_name,tr.description as question_type_description,
                tr.identifying_features as question_type_identifying_features,tr.standard_method as question_type_standard_method,
                qr.chapter_id,qr.module_2 as question_module_2,qr.module_3 as question_module_3,
                qr.stem_format,qr.stem_markdown,qr.difficulty as question_difficulty,
                qr.question_type_revision_id,qr.analysis_markdown,
                er.category as error_category,er.name as error_name,er.description as error_description,
                er.manifestation as error_manifestation,er.judgment_basis as error_judgment_basis,er.remediation as error_remediation,
                rr.rule_version,rr.trigger_text,rr.probe_text
           from content_candidate_set_item i
           join content_entity_revision r on r.revision_id=i.revision_id
           join content_entity e on e.entity_id=r.entity_id
           left join content_knowledge_revision kr on kr.revision_id=r.revision_id
           left join content_question_type_revision tr on tr.revision_id=r.revision_id
           left join content_question_revision qr on qr.revision_id=r.revision_id
           left join content_error_cause_revision er on er.revision_id=r.revision_id
           left join content_diagnosis_rule_revision rr on rr.revision_id=r.revision_id
          where i.tenant_id=$1 and i.candidate_set_id=$2 order by i.item_order`,
        [principal.tenantId, candidateSetId],
      );
      const annotations = await client.query(
        `select annotation_id,revision_id,revision_item_id,field_name,comment_text,author_user_id,state,created_at,submitted_at,withdrawn_at
           from content_review_annotation where tenant_id=$1 and candidate_set_id=$2 order by created_at`,
        [principal.tenantId, candidateSetId],
      );
      const provenance = await client.query(
        `select p.provenance_id,p.revision_id,p.revision_item_id,p.field_name,p.source_locator,
                p.source_object_id,o.version_id as source_version_id,o.sha256 as source_sha256,
                p.derivation_type,p.provenance_status,p.review_decision,p.created_at
           from content_field_provenance p
           join content_candidate_set_item i on i.revision_id=p.revision_id and i.tenant_id=p.tenant_id
           left join storage_object o on o.object_id=p.source_object_id and o.tenant_id=p.tenant_id
          where p.tenant_id=$1 and i.candidate_set_id=$2
          order by p.revision_id,p.field_name,p.created_at`,
        [principal.tenantId, candidateSetId],
      );
      const decision = await client.query(
        `select decision_id,decision,decided_by_user_id,decided_at,
                feedback_attempt_count,feedback_last_error,feedback_dispatched_at
           from content_review_decision where tenant_id=$1 and candidate_set_id=$2`,
        [principal.tenantId, candidateSetId],
      );
      const erStart = await client.query(
        `select target_thread_id,status,attempt_count,last_error,dispatched_at
           from content_er_start_command
          where tenant_id=$1 and approved_ktq_candidate_set_id=$2`,
        [principal.tenantId, candidateSetId],
      );
      return { candidate: this.mapSummary(row), input_candidate_set_id: row.input_candidate_set_id, supersedes_candidate_set_id: row.supersedes_candidate_set_id, result_sha256: row.result_sha256, respond_tool_call_id: row.respond_tool_call_id, items: items.rows, annotations: annotations.rows, provenance: provenance.rows, decision: decision.rows[0] ?? null, er_start_command: erStart.rows[0] ?? null };
    });
  }

  /** Return the small, immutable KTQ handoff document consumed by ER.  It is
   * built from normalized revisions rather than replaying the model's JSON
   * payload, so an ER retry always sees the exact approved dimensions. */
  async frozenKtq(principal: Principal, candidateSetId: string): Promise<Json | null> {
    return withPrincipal(this.pool, principal, async (client) => {
      const candidate = await client.query<{ phase: Phase; status: string; owner_teacher_user_id: string }>(
        `select phase,status,owner_teacher_user_id
           from content_candidate_set
          where tenant_id=$1 and candidate_set_id=$2`,
        [principal.tenantId, candidateSetId],
      );
      const header = candidate.rows[0];
      if (!header || header.phase !== "ktq" || header.status !== "approved" || header.owner_teacher_user_id !== principal.userId) return null;
      const questions = await client.query(
        `select distinct on (e.entity_id)
                e.entity_id as question_id,qr.chapter_id,qr.stem_format,qr.stem_markdown,
                qr.difficulty,qr.analysis_markdown,
                te.entity_id as question_type_id,tr.name as question_type_name
           from content_candidate_set_item ci
           join content_entity_revision r on r.revision_id=ci.revision_id
           join content_entity e on e.entity_id=r.entity_id and e.entity_kind='question'
           join content_question_revision qr on qr.revision_id=r.revision_id
           left join content_entity te on te.tenant_id=e.tenant_id and te.entity_id=(
             select entity_id from content_entity_revision where revision_id=qr.question_type_revision_id
           )
           left join content_question_type_revision tr on tr.revision_id=qr.question_type_revision_id
          where ci.tenant_id=$1 and ci.candidate_set_id=$2
          order by e.entity_id,r.revision_no desc`,
        [principal.tenantId, candidateSetId],
      );
      const resultQuestions: Json[] = [];
      for (const row of questions.rows as Array<Record<string, unknown>>) {
        const targets = await client.query(
          `select de.entity_id as dim,mt.target_role as role,mt.evidence_rule
             from content_revision_item ri
             join content_question_measurement_target mt on mt.item_id=ri.item_id
             join content_entity_revision dr on dr.revision_id=mt.dimension_revision_id
             join content_entity de on de.entity_id=dr.entity_id
            where ri.tenant_id=$1 and ri.revision_id=(
              select revision_id from content_entity_revision
               where entity_id=$2 and tenant_id=$1 and lifecycle_status='approved'
               order by revision_no desc limit 1
            ) order by ri.position`,
          [principal.tenantId, row.question_id],
        );
        const dimensions = (targets.rows as Array<{ dim: string }>).map((item) => item.dim);
        const knowledge = await client.query(
          `select de.entity_id as id,kr.name,kr.description
             from content_revision_item ri
             join content_question_measurement_target mt on mt.item_id=ri.item_id
             join content_entity_revision dr on dr.revision_id=mt.dimension_revision_id
             join content_entity de on de.entity_id=dr.entity_id and de.entity_kind='knowledge'
             join content_knowledge_revision kr on kr.revision_id=dr.revision_id
            where ri.tenant_id=$1 and ri.revision_id=(
              select revision_id from content_entity_revision
               where entity_id=$2 and tenant_id=$1 and lifecycle_status='approved'
               order by revision_no desc limit 1
            ) order by ri.position`,
          [principal.tenantId, row.question_id],
        );
        resultQuestions.push({
          question_id: row.question_id,
          chapter_id: row.chapter_id,
          stem_format: row.stem_format,
          stem_markdown: row.stem_markdown,
          difficulty: row.difficulty,
          analysis_markdown: row.analysis_markdown,
          knowledge_components: knowledge.rows,
          question_type: { id: row.question_type_id, name: row.question_type_name ?? row.question_type_id },
          measurement_dims: dimensions,
          measurement_targets: targets.rows,
        });
      }
      return { schema: "mathpilot.ktq-result/v1", candidate_set_id: candidateSetId, questions: resultQuestions };
    });
  }

  async list(principal: Principal, status?: string): Promise<CandidateSummary[]> {
    return withPrincipal(this.pool, principal, async (client) => {
      const result = await client.query<CandidateSummary>(
        `select s.*, (select count(*)::int from content_candidate_set_item i where i.candidate_set_id=s.candidate_set_id) as item_count
           from content_candidate_set s
          where s.tenant_id=$1 and s.owner_teacher_user_id=$2
            and ($3::text is null or s.status=$3)
          order by s.created_at desc limit 100`,
        [principal.tenantId, principal.userId, status ?? null],
      );
      return result.rows.map((row) => this.mapSummary(row));
    });
  }

  /** 教师给解析批次（候选集）起名/改名；传空名则恢复默认显示名。仅批次所有者可操作。 */
  async renameCandidateDisplayName(principal: Principal, candidateSetId: string, displayName: string | null): Promise<boolean> {
    const title = String(displayName ?? "").trim().slice(0, 120);
    return withPrincipal(this.pool, principal, async (client) => {
      const result = await client.query(
        `update content_candidate_set
            set display_name=$3
          where tenant_id=$1 and candidate_set_id=$2 and owner_teacher_user_id=$4
          returning candidate_set_id`,
        [principal.tenantId, candidateSetId, title === "" ? null : title, principal.userId],
      );
      return (result.rowCount ?? 0) === 1;
    });
  }

  /** 教师归档（软删）解析批次。题目 revision 受不可变守护保护无法物理删除，因此仅打 deleted_at 归档标记；列表查询忽略已删批次。 */
  async deleteCandidateSet(principal: Principal, candidateSetId: string): Promise<boolean> {
    return withPrincipal(this.pool, principal, async (client) => {
      await assertTeacher(client, principal);
      const result = await client.query(
        `update content_candidate_set set deleted_at=now()
          where tenant_id=$1 and candidate_set_id=$2 and owner_teacher_user_id=$3 and deleted_at is null`,
        [principal.tenantId, candidateSetId, principal.userId],
      );
      return (result.rowCount ?? 0) === 1;
    });
  }

  async searchLibrary(
    principal: Principal,
    kinds: EntityKind[] | undefined,
    query: string,
    offset: number,
    limit: number,
  ): Promise<{ items: Array<{ entity_kind: EntityKind; entity_id: string; entity_ref: string; label: string; summary: string }>; nextOffset: number | null; queryFallback: boolean }> {
    return withPrincipal(this.pool, principal, async (client) => {
      // A teacher's model may use the teacher's own candidates and official
      // content.  A student's model also needs the package revisions released
      // to the student's active class; the SQL visibility function keeps that
      // branch out of teacher/model scope automatically.
      const modelScope = principal.roles.includes("teacher");
      const requested = kinds?.length ? kinds : ["knowledge", "question_type", "question", "error_cause", "diagnosis_rule"] as EntityKind[];
      const search = async (searchQuery: string) => {
        const result: Array<{ entity_kind: EntityKind; entity_id: string; entity_ref: string; label: string; summary: string }> = [];
        for (const kind of requested) {
          const pattern = `%${searchQuery}%`;
          const rows = await client.query<{ entity_id: string; label: string; summary: string }>(
            `with latest as (
             select distinct on (e.entity_id) e.entity_id,e.entity_kind,r.revision_id
               from content_entity e join content_entity_revision r on r.entity_id=e.entity_id and r.tenant_id=e.tenant_id
              where e.tenant_id=$1 and e.entity_kind=$2 and r.lifecycle_status in ('approved','ready')
              order by e.entity_id,r.revision_no desc
           )
           select l.entity_id,
             case when l.entity_kind='knowledge' then kr.name
                  when l.entity_kind='question_type' then tr.name
                  when l.entity_kind='question' then left(qr.stem_markdown,240)
                  when l.entity_kind='error_cause' then er.name
                  else left(rr.trigger_text,240) end as label,
             case when l.entity_kind='knowledge' then kr.description
                  when l.entity_kind='question_type' then tr.description
                  when l.entity_kind='question' then qr.analysis_markdown
                  when l.entity_kind='error_cause' then er.description
                  else rr.probe_text end as summary
             from latest l
             join content_entity e on e.entity_id=l.entity_id
             left join content_knowledge_revision kr on kr.revision_id=l.revision_id
             left join content_question_type_revision tr on tr.revision_id=l.revision_id
             left join content_question_revision qr on qr.revision_id=l.revision_id
             left join content_error_cause_revision er on er.revision_id=l.revision_id
             left join content_diagnosis_rule_revision rr on rr.revision_id=l.revision_id
              where mathpilot_content_entity_visible($1,$3,$4,l.entity_kind,l.entity_id,$5)
              and ($6='' or concat_ws(' ',l.entity_id,kr.name,kr.description,tr.name,tr.description,
                    left(qr.stem_markdown,240),left(qr.analysis_markdown,240),er.name,er.description,
                    left(rr.trigger_text,240),left(rr.probe_text,240)) ilike $7)
            order by l.entity_id limit $8 offset $9`,
            [principal.tenantId, kind, principal.userId, principal.roles, modelScope, searchQuery, pattern, limit + 1, requested.length === 1 ? offset : 0],
          );
          result.push(...rows.rows.slice(0, limit + 1).map((row) => ({ entity_kind: kind, entity_id: row.entity_id, entity_ref: `${kind}:${row.entity_id}`, label: row.label ?? row.entity_id, summary: row.summary ?? "" })));
        }
        return result;
      };
      let result = await search(query);
      const queryFallback = query.length > 0 && result.length === 0;
      if (queryFallback) result = await search("");
      result.sort((a, b) => `${a.entity_kind}:${a.entity_id}`.localeCompare(`${b.entity_kind}:${b.entity_id}`));
      const page = result.slice(0, limit);
      return { items: page, nextOffset: requested.length === 1 && result.length > limit ? offset + limit : null, queryFallback };
    });
  }

  async getLibrary(principal: Principal, kind: EntityKind, entityId: string): Promise<Json | null> {
    return withPrincipal(this.pool, principal, async (client) => {
      const modelScope = principal.roles.includes("teacher");
      const visible = await client.query<{ visible: boolean }>(
        `select mathpilot_content_entity_visible($1,$2,$3,$4,$5,$6) as visible`,
        [principal.tenantId, principal.userId, principal.roles, kind, entityId, modelScope],
      );
      if (!visible.rows[0]?.visible) return null;
      const row = await client.query(
        `with latest as (
           select distinct on (r.entity_id) r.* from content_entity_revision r
            where r.tenant_id=$1 and r.entity_id=$2 and r.lifecycle_status in ('approved','ready')
            order by r.entity_id,r.revision_no desc
         )
         select e.entity_id,e.entity_kind,e.origin,e.owner_teacher_user_id,l.revision_id,l.revision_no,
                kr.name as knowledge_name,kr.description as knowledge_description,kr.grade_band,kr.difficulty as knowledge_difficulty,kr.mastery_standard,kr.remediation_advice,
                tr.name as question_type_name,tr.description as question_type_description,tr.identifying_features,tr.standard_method,
                qr.chapter_id,qr.stem_format,qr.stem_markdown,qr.difficulty,qr.analysis_markdown,
                er.category,er.name as error_name,er.description as error_description,er.manifestation,er.judgment_basis,er.remediation,
                rr.rule_version,rr.trigger_text,rr.probe_text
           from content_entity e join latest l on l.entity_id=e.entity_id
           left join content_knowledge_revision kr on kr.revision_id=l.revision_id
           left join content_question_type_revision tr on tr.revision_id=l.revision_id
           left join content_question_revision qr on qr.revision_id=l.revision_id
           left join content_error_cause_revision er on er.revision_id=l.revision_id
           left join content_diagnosis_rule_revision rr on rr.revision_id=l.revision_id
          where e.tenant_id=$1 and e.entity_id=$2 and e.entity_kind=$3`,
        [principal.tenantId, entityId, kind],
      );
      const value = row.rows[0] as Json | undefined;
      if (!value) return null;
      return { entity_kind: kind, entity_id: entityId, revision_id: value.revision_id, revision_no: value.revision_no, data: value };
    });
  }

  async listPackages(principal: Principal): Promise<Json[]> {
    return withPrincipal(this.pool, principal, async (client) => {
      const result = await client.query(
        `select p.package_id,p.origin,p.owner_teacher_user_id,p.title,p.version_no,p.status,p.manifest_sha256,p.created_at,
                p.approved_er_candidate_set_id,
                count(pi.revision_id)::int as item_count
           from content_package p left join content_package_item pi on pi.package_id=p.package_id
          where p.tenant_id=$1 and mathpilot_content_package_visible($1,$2,$3,p.package_id,false)
          group by p.package_id order by p.created_at desc limit 100`,
        [principal.tenantId, principal.userId, principal.roles],
      );
      return result.rows as Json[];
    });
  }

  async deleteTeacherPackage(principal: Principal, packageId: string): Promise<boolean> {
    return withPrincipal(this.pool, principal, async (client) => {
      const owner = await client.query<{ package_id: string }>(
        `select package_id from content_package p
          where p.tenant_id=$1 and p.package_id=$2 and p.origin='teacher'
            and p.owner_teacher_user_id=$3 and p.status='ready'
          for update`,
        [principal.tenantId, packageId, principal.userId],
      );
      if (!owner.rows[0]) return false;
      // 先删除包内 items（守卫只放行“所属教师包仍为 ready”时的删除），再删包。
      await client.query(`delete from content_package_item where tenant_id=$1 and package_id=$2`, [principal.tenantId, packageId]);
      const result = await client.query(`delete from content_package p where p.tenant_id=$1 and p.package_id=$2 returning p.package_id`, [principal.tenantId, packageId]);
      return (result.rowCount ?? 0) === 1;
    });
  }

  /** 教师自选题组卷：列出该教师可挑选的题目（本人解析、已批准/就绪的最新修订）。 */
  async listManualPickableQuestions(principal: Principal): Promise<Json[]> {
    return withPrincipal(this.pool, principal, async (client) => {
      const result = await client.query(
        `with latest as (
           select distinct on (e.entity_id) e.entity_id, r.revision_id, r.revision_no,
                  r.lifecycle_status, r.candidate_set_id
             from content_entity e
             join content_entity_revision r on r.entity_id=e.entity_id and r.tenant_id=e.tenant_id
            where e.tenant_id=$1 and e.entity_kind='question'
              and e.origin in ('teacher','official')
              and (e.origin='official' or e.owner_teacher_user_id=$2)
              and r.lifecycle_status in ('approved','ready')
            order by e.entity_id, r.revision_no desc
         )
         select l.entity_id, l.revision_id, l.revision_no, l.lifecycle_status,
                l.candidate_set_id as batch_id, cs.display_name as batch_display_name,
                cs.phase as batch_phase, qr.chapter_id, qr.module_2 as module_2, qr.module_3 as module_3,
                qr.stem_format, qr.difficulty,
                left(qr.stem_markdown, 220) as stem_preview,
                tr.name as question_type_name
           from latest l
           join content_entity e on e.entity_id=l.entity_id
           join content_question_revision qr on qr.revision_id=l.revision_id
           left join content_question_type_revision tr on tr.revision_id=qr.question_type_revision_id
           left join content_candidate_set cs on cs.candidate_set_id=l.candidate_set_id
          order by l.entity_id limit 500`,
        [principal.tenantId, principal.userId],
      );
      return result.rows as Json[];
    });
  }

  /** 教师自选题组卷：用选中题目 revision 创建 manual 练习包（ready，可直接发布）。 */
  async createManualTeacherPackage(principal: Principal, title: string, revisionIds: string[]): Promise<Json> {
    const cleanTitle = String(title ?? "").trim().slice(0, 200);
    if (!cleanTitle) throw new Error("package title must not be empty");
    const ids = [...new Set(revisionIds.map((value) => String(value).trim()).filter(Boolean))];
    if (!ids.length) throw new Error("select at least one question");
    if (ids.length > 200) throw new Error("too many questions (max 200)");
    return withPrincipal(this.pool, principal, async (client) => {
      const picks = await client.query<{ entity_id: string; entity_kind: string; owner_teacher_user_id: string; lifecycle_status: string }>(
        `select e.entity_id, e.entity_kind, e.owner_teacher_user_id, r.lifecycle_status
           from content_entity e join content_entity_revision r on r.entity_id=e.entity_id and r.tenant_id=e.tenant_id
          where r.tenant_id=$1 and r.revision_id=any($2::text[])`,
        [principal.tenantId, ids],
      );
      if (picks.rows.length !== ids.length) throw new Error("some revisions are not found");
      const entities = new Set<string>();
      for (const row of picks.rows) {
        if (row.entity_kind !== "question") throw new Error("only question revisions can be picked");
        if (row.owner_teacher_user_id !== principal.userId) throw new Error("question is not owned by this teacher");
        if (row.lifecycle_status !== "approved" && row.lifecycle_status !== "ready") throw new Error("question revision is not approved");
        if (entities.has(row.entity_id)) throw new Error("duplicate question entity in selection");
        entities.add(row.entity_id);
      }
      await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [`package-version:${principal.tenantId}:${principal.userId}`]);
      const version = await client.query<{ version_no: number }>(
        `select coalesce(max(version_no),0)+1 as version_no from content_package where tenant_id=$1 and owner_teacher_user_id=$2`,
        [principal.tenantId, principal.userId],
      );
      const packageId = newId("pkg");
      const versionNo = Number(version.rows[0]?.version_no ?? 1);
      await client.query(
        `insert into content_package(package_id,tenant_id,origin,owner_teacher_user_id,title,version_no,status,manual_build)
         values ($1,$2,'teacher',$3,$4,$5,'ready',true)`,
        [packageId, principal.tenantId, principal.userId, cleanTitle, versionNo],
      );
      await client.query(
        `update content_entity_revision set lifecycle_status='ready'
          where tenant_id=$1 and revision_id=any($2::text[]) and lifecycle_status='approved'`,
        [principal.tenantId, ids],
      );
      for (const [index, revisionId] of ids.entries()) {
        await client.query(
          `insert into content_package_item(tenant_id,package_id,revision_id,item_order) values ($1,$2,$3,$4)`,
          [principal.tenantId, packageId, revisionId, index],
        );
      }
      return { package_id: packageId, title: cleanTitle, version_no: versionNo, status: "ready", item_count: ids.length };
    });
  }

  /** 教师给自有练习包改名（teacher origin，任意非撤回状态）。 */
  async renameTeacherPackageTitle(principal: Principal, packageId: string, title: string): Promise<boolean> {
    const cleanTitle = String(title ?? "").trim().slice(0, 200);
    if (!cleanTitle) throw new Error("package title must not be empty");
    return withPrincipal(this.pool, principal, async (client) => {
      const result = await client.query(
        `update content_package p
            set title=$4
          where p.tenant_id=$1 and p.package_id=$2 and p.origin='teacher'
            and p.owner_teacher_user_id=$3 and p.status <> 'withdrawn'
          returning p.package_id`,
        [principal.tenantId, packageId, principal.userId, cleanTitle],
      );
      return (result.rowCount ?? 0) === 1;
    });
  }

  async teacherParseProgress(principal: Principal, threadId: string): Promise<Record<string, unknown>> {
    return withPrincipal(this.pool, principal, async (client) => {
      const command = (await client.query(
        `select command_id,status,last_error,created_at from content_ktq_start_command
          where tenant_id=$1 and owner_teacher_user_id=$2 and target_thread_id=$3`,
        [principal.tenantId, principal.userId, threadId],
      )).rows[0];
      if (!command) return { stage: "none" };
      const ktq = (await client.query(
        `select candidate_set_id,status,
                (select count(*)::int from content_candidate_set_item i where i.candidate_set_id=s.candidate_set_id) as item_count
           from content_candidate_set s
          where s.tenant_id=$1 and s.owner_teacher_user_id=$2 and s.thread_id=$3
          order by s.created_at limit 1`,
        [principal.tenantId, principal.userId, threadId],
      )).rows[0] ?? null;
      const erThreads = ktq && ktq.status === "approved"
        ? (await client.query(
          `select target_thread_id from content_er_start_command
            where tenant_id=$1 and approved_ktq_candidate_set_id=$2`,
          [principal.tenantId, ktq.candidate_set_id],
        )).rows.map((row) => row.target_thread_id)
        : [];
      const er = erThreads.length
        ? (await client.query(
          `select candidate_set_id,status,
                  (select count(*)::int from content_candidate_set_item i where i.candidate_set_id=s.candidate_set_id) as item_count
             from content_candidate_set s
            where s.tenant_id=$1 and s.owner_teacher_user_id=$2 and s.thread_id=any($3::text[])
            order by s.created_at limit 1`,
          [principal.tenantId, principal.userId, erThreads],
        )).rows[0] ?? null
        : null;
      const pkg = er && er.status === "approved"
        ? (await client.query(
          `select package_id,status from content_package
            where tenant_id=$1 and origin='teacher' and owner_teacher_user_id=$2 and approved_er_candidate_set_id=$3
            order by created_at desc limit 1`,
          [principal.tenantId, principal.userId, er.candidate_set_id],
        )).rows[0] ?? null
        : null;
      let stage = "parsing";
      if (ktq && ktq.status === "pending_review") stage = "reviewing";
      else if (ktq && ktq.status === "approved" && !er) stage = "er";
      else if (pkg) stage = "done";
      else if (command.status === "dispatched") stage = "parsing";
      return {
        stage,
        command_status: command.status,
        last_error: command.last_error ?? null,
        ktq_candidate: ktq ?? null,
        er_candidate: er ?? null,
        package: pkg ?? null,
      };
    });
  }

  async getPackage(principal: Principal, packageId: string, modelScope = false): Promise<Json | null> {
    return withPrincipal(this.pool, principal, async (client) => {
      const visible = await client.query<{ visible: boolean }>(`select mathpilot_content_package_visible($1,$2,$3,$4,$5) as visible`, [principal.tenantId, principal.userId, principal.roles, packageId, modelScope]);
      if (!visible.rows[0]?.visible) return null;
      const packageRow = await client.query(`select package_id,origin,owner_teacher_user_id,title,version_no,status,manifest_object_id,manifest_sha256,approved_er_candidate_set_id,created_at from content_package where tenant_id=$1 and package_id=$2`, [principal.tenantId, packageId]);
      if (!packageRow.rows[0]) return null;
      const items = await client.query(
        `select pi.item_order,e.entity_id,e.entity_kind,r.revision_id,r.revision_no
           from content_package_item pi join content_entity_revision r on r.revision_id=pi.revision_id
           join content_entity e on e.entity_id=r.entity_id
          where pi.tenant_id=$1 and pi.package_id=$2 order by pi.item_order`,
        [principal.tenantId, packageId],
      );
      const releases = await client.query(
        `select release_id,class_id,published_at,withdrawn_at
           from content_package_class_release
          where tenant_id=$1 and package_id=$2 order by published_at desc`,
        [principal.tenantId, packageId],
      );
      return { package: packageRow.rows[0], items: items.rows, releases: releases.rows };
    });
  }

  async releasePackage(principal: Principal, packageId: string, classId: string): Promise<Json> {
    return withPrincipal(this.pool, principal, async (client) => {
      const allowed = await client.query<{ allowed: boolean }>(`select mathpilot_content_can_publish_package($1,$2,$3,$4,$5) as allowed`, [principal.tenantId, principal.userId, principal.roles, packageId, classId]);
      if (!allowed.rows[0]?.allowed) throw new Error("only the owning teacher can release this ready package to their class");
      const classExists = await client.query(`select 1 from identity_class where tenant_id=$1 and class_id=$2 and status='active'`, [principal.tenantId, classId]);
      if (!classExists.rows.length) throw new Error("class not found");
      const result = await client.query(
        `insert into content_package_class_release(release_id,tenant_id,package_id,class_id,published_by_user_id)
         values ($1,$2,$3,$4,$5)
         on conflict (package_id,class_id) do update set withdrawn_at=null,published_at=now(),published_by_user_id=excluded.published_by_user_id
         returning release_id,package_id,class_id,published_at,withdrawn_at`,
        [newId("release"), principal.tenantId, packageId, classId, principal.userId],
      );
      await client.query(`update content_package set status='published' where package_id=$1 and status='ready'`, [packageId]);
      return result.rows[0] as Json;
    });
  }

  async withdrawPackage(principal: Principal, packageId: string, classId: string): Promise<Json> {
    return withPrincipal(this.pool, principal, async (client) => {
      const allowed = await client.query<{ allowed: boolean }>(`select mathpilot_content_can_publish_package($1,$2,$3,$4,$5) as allowed`, [principal.tenantId, principal.userId, principal.roles, packageId, classId]);
      if (!allowed.rows[0]?.allowed) throw new Error("only the owning teacher can withdraw this package release");
      const result = await client.query(`update content_package_class_release set withdrawn_at=now() where tenant_id=$1 and package_id=$2 and class_id=$3 returning release_id,package_id,class_id,published_at,withdrawn_at`, [principal.tenantId, packageId, classId]);
      if (!result.rows[0]) throw new Error("package release not found");
      return result.rows[0] as Json;
    });
  }

  async annotate(principal: Principal, candidateSetId: string, input: { revisionId: string; revisionItemId?: string | null; fieldName?: string | null; commentText: string; state: "draft" | "submitted" | "withdrawn" }): Promise<Json> {
    return withPrincipal(this.pool, principal, async (client) => {
      const visible = await client.query(
        `select 1 from content_candidate_set
          where tenant_id=$1 and candidate_set_id=$2 and owner_teacher_user_id=$3
            and status='pending_review'`,
        [principal.tenantId, candidateSetId, principal.userId],
      );
      if (!visible.rows.length) throw new Error("candidate not found or finalized");
      if (!input.commentText.trim() || input.commentText.length > 10000) throw new Error("comment_text must contain 1..10000 characters");
      const relation = await client.query<{ entity_kind: EntityKind }>(
        `select e.entity_kind
           from content_candidate_set_item i
           join content_entity_revision r on r.revision_id=i.revision_id
           join content_entity e on e.entity_id=r.entity_id
          where i.tenant_id=$1 and i.candidate_set_id=$2 and i.revision_id=$3`,
        [principal.tenantId, candidateSetId, input.revisionId],
      );
      if (!relation.rows.length) throw new Error("revision is not part of this candidate");
      if (input.fieldName && !REVIEW_FIELDS[relation.rows[0]!.entity_kind].has(input.fieldName)) throw new Error("field_name is not reviewable for this entity kind");
      if (input.revisionItemId && !input.fieldName) throw new Error("revision item annotations require field_name");
      if (input.revisionItemId) {
        const item = await client.query(`select 1 from content_revision_item where tenant_id=$1 and item_id=$2 and revision_id=$3`, [principal.tenantId, input.revisionItemId, input.revisionId]);
        if (!item.rows.length) throw new Error("revision_item does not belong to revision");
      }
      const id = newId("ann");
      await client.query(
        `insert into content_review_annotation(annotation_id,tenant_id,candidate_set_id,revision_id,revision_item_id,field_name,comment_text,author_user_id,state,submitted_at,withdrawn_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,case when $9='submitted' then now() end,case when $9='withdrawn' then now() end)`,
        [id, principal.tenantId, candidateSetId, input.revisionId, input.revisionItemId ?? null, input.fieldName ?? null, input.commentText.trim(), principal.userId, input.state],
      );
      return { annotation_id: id, state: input.state };
    });
  }

  async withdrawAnnotation(principal: Principal, candidateSetId: string, annotationId: string): Promise<Json> {
    return withPrincipal(this.pool, principal, async (client) => {
      const result = await client.query(
        `update content_review_annotation a
            set state='withdrawn',withdrawn_at=now()
           from content_candidate_set s
          where a.tenant_id=$1 and a.annotation_id=$2 and a.candidate_set_id=$3
            and a.author_user_id=$4 and a.state in ('draft','submitted')
            and s.tenant_id=a.tenant_id and s.candidate_set_id=a.candidate_set_id
            and s.owner_teacher_user_id=$4 and s.status='pending_review'
        returning a.annotation_id,a.state,a.withdrawn_at`,
        [principal.tenantId, annotationId, candidateSetId, principal.userId],
      );
      if (!result.rows[0]) throw new Error("active annotation not found");
      return result.rows[0] as Json;
    });
  }

  async decide(principal: Principal, candidateSetId: string, decision: "changes_requested" | "approved"): Promise<Json> {
    return withPrincipal(this.pool, principal, async (client) => {
      const candidate = await client.query<{ phase: Phase; owner_teacher_user_id: string; status: string }>(
        `select phase,owner_teacher_user_id,status from content_candidate_set where tenant_id=$1 and candidate_set_id=$2 for update`,
        [principal.tenantId, candidateSetId],
      );
      const row = candidate.rows[0];
      if (!row) throw new Error("candidate not found");
      if (row.owner_teacher_user_id !== principal.userId) throw new Error("candidate is not owned by this teacher");
      if (row.status !== "pending_review") throw new Error("candidate is already finalized");
      const active = await client.query<{ n: number }>(
        `select count(*)::int as n from content_review_annotation where tenant_id=$1 and candidate_set_id=$2 and state in ('draft','submitted')`,
        [principal.tenantId, candidateSetId],
      );
      if (decision === "approved" && Number(active.rows[0]?.n ?? 0) > 0) throw new Error("withdraw or resolve active annotations before approval");
      if (decision === "changes_requested" && Number(active.rows[0]?.n ?? 0) === 0) throw new Error("add at least one annotation before requesting changes");
      await client.query(
        `insert into content_review_decision(decision_id,tenant_id,candidate_set_id,decision,decided_by_user_id)
         values ($1,$2,$3,$4,$5)`,
        [newId("decision"), principal.tenantId, candidateSetId, decision, principal.userId],
      );
      await client.query(`update content_candidate_set set status=$2,decided_at=now() where candidate_set_id=$1`, [candidateSetId, decision]);
      let packageId: string | undefined;
      let targetThreadId: string | undefined;
      if (decision === "approved") {
        await client.query(
          `update content_field_provenance p set review_decision='confirmed'
            from content_candidate_set_item i
           where i.candidate_set_id=$1 and i.revision_id=p.revision_id and p.review_decision='pending'`,
          [candidateSetId],
        );
        await client.query(`update content_entity_revision set lifecycle_status='approved' where candidate_set_id=$1 and lifecycle_status='candidate'`, [candidateSetId]);
        if (row.phase === "ktq") {
          const commandId = newId("ercmd");
          targetThreadId = newId("thread");
          await client.query(
            `insert into content_er_start_command(command_id,tenant_id,approved_ktq_candidate_set_id,target_thread_id)
             values ($1,$2,$3,$4) on conflict (approved_ktq_candidate_set_id) do nothing`,
            [commandId, principal.tenantId, candidateSetId, targetThreadId],
          );
        } else {
          packageId = await createReadyPackage(client, principal, candidateSetId);
          await client.query(
            `update content_entity_revision set lifecycle_status='ready'
              where lifecycle_status='approved' and candidate_set_id in (
                $1,
                (select input_candidate_set_id from content_candidate_set where candidate_set_id=$1)
              )`,
            [candidateSetId],
          );
        }
      } else {
        await client.query(
          `update content_field_provenance p set review_decision='modified'
            from content_review_annotation a
           where a.candidate_set_id=$1 and a.state in ('draft','submitted')
             and a.revision_id=p.revision_id
             and (a.revision_item_id is null or a.revision_item_id=p.revision_item_id)
             and (a.field_name is null or a.field_name=p.field_name)
             and p.review_decision='pending'`,
          [candidateSetId],
        );
      }
      return {
        candidate_set_id: candidateSetId,
        decision,
        phase: row.phase,
        ...(packageId ? { package_id: packageId } : {}),
        ...(targetThreadId ? { target_thread_id: targetThreadId } : {}),
      };
    });
  }

  async pendingCommands(): Promise<Array<{ command_id: string; tenant_id: string; owner_user_id: string; approved_ktq_candidate_set_id: string; target_thread_id: string; attempt_count: number }>> {
    return withPrincipal(this.pool, { tenantId: "", userId: "", roles: [] }, async (client) => {
      // The worker is trusted and uses the security-definer function; no user
      // context is needed for this read. Resetting the tenant to an empty value
      // keeps all ordinary RLS queries closed if this method is accidentally
      // reused by a request handler.
      const result = await client.query(`select * from mathpilot_pending_er_start_commands()`);
      return result.rows as Array<{ command_id: string; tenant_id: string; owner_user_id: string; approved_ktq_candidate_set_id: string; target_thread_id: string; attempt_count: number }>;
    });
  }

  async markCommandAttempt(commandId: string, tenantId: string, ownerUserId: string, error: string | null): Promise<void> {
    await withPrincipal(this.pool, { tenantId, userId: ownerUserId, roles: ["teacher"] }, async (client) => {
      await client.query(
        `update content_er_start_command
            set attempt_count=attempt_count+1,last_error=$2,next_attempt_at=now()+least(interval '10 minutes', interval '5 seconds' * power(2, least(attempt_count, 7)))
          where command_id=$1 and status='pending'`,
        [commandId, error],
      );
    });
  }

  async markCommandDispatched(commandId: string, tenantId: string, ownerUserId: string): Promise<void> {
    await withPrincipal(this.pool, { tenantId, userId: ownerUserId, roles: ["teacher"] }, async (client) => {
      await client.query(`update content_er_start_command set status='dispatched',dispatched_at=now(),last_error=null where command_id=$1 and status='pending'`, [commandId]);
    });
  }

  async createKtqStartCommand(
    principal: Principal,
    value: { commandId: string; targetThreadId: string; chapterId?: string | null },
  ): Promise<{ command_id: string; status: string }> {
    return withPrincipal(this.pool, principal, async (client) => {
      await client.query(
        `insert into content_ktq_start_command(command_id,tenant_id,owner_teacher_user_id,target_thread_id,chapter_id)
         values ($1,$2,$3,$4,$5)
         on conflict (target_thread_id) do update set chapter_id=excluded.chapter_id
         returning command_id,status`,
        [value.commandId, principal.tenantId, principal.userId, value.targetThreadId, value.chapterId ?? null],
      );
      const row = (await client.query(
        `select command_id,status from content_ktq_start_command
          where tenant_id=$1 and owner_teacher_user_id=$2 and target_thread_id=$3`,
        [principal.tenantId, principal.userId, value.targetThreadId],
      )).rows[0];
      return { command_id: String(row.command_id), status: String(row.status) };
    });
  }

  async pendingKtqCommands(): Promise<Array<{ command_id: string; tenant_id: string; owner_user_id: string; target_thread_id: string; chapter_id: string | null; attempt_count: number }>> {
    return withPrincipal(this.pool, { tenantId: "", userId: "", roles: [] }, async (client) => {
      const result = await client.query(`select * from mathpilot_pending_ktq_start_commands()`);
      return result.rows as Array<{ command_id: string; tenant_id: string; owner_user_id: string; target_thread_id: string; chapter_id: string | null; attempt_count: number }>;
    });
  }

  async markKtqCommandAttempt(commandId: string, tenantId: string, ownerUserId: string, error: string | null): Promise<void> {
    await withPrincipal(this.pool, { tenantId, userId: ownerUserId, roles: ["teacher"] }, async (client) => {
      await client.query(
        `update content_ktq_start_command
            set attempt_count=attempt_count+1,last_error=$2,next_attempt_at=now()+least(interval '10 minutes', interval '5 seconds' * power(2, least(attempt_count, 7)))
          where command_id=$1 and status='pending'`,
        [commandId, error],
      );
    });
  }

  async markKtqCommandDispatched(commandId: string, tenantId: string, ownerUserId: string): Promise<void> {
    await withPrincipal(this.pool, { tenantId, userId: ownerUserId, roles: ["teacher"] }, async (client) => {
      await client.query(`update content_ktq_start_command set status='dispatched',dispatched_at=now(),last_error=null where command_id=$1 and status='pending'`, [commandId]);
    });
  }

  async pendingAutoPrivateCandidates(): Promise<Array<{ candidate_set_id: string; tenant_id: string; owner_user_id: string; phase: string }>> {
    return withPrincipal(this.pool, { tenantId: "", userId: "", roles: [] }, async (client) => {
      const result = await client.query(`select * from mathpilot_pending_auto_private_candidates()`);
      return result.rows as Array<{ candidate_set_id: string; tenant_id: string; owner_user_id: string; phase: string }>;
    });
  }

  async pendingFeedbackCommands(): Promise<Array<{
    command_id: string;
    tenant_id: string;
    owner_user_id: string;
    candidate_set_id: string;
    target_thread_id: string;
    phase: Phase;
    annotations: Array<{ revision_id: string; revision_item_id: string | null; field_name: string | null; comment_text: string }>;
    attempt_count: number;
  }>> {
    return withPrincipal(this.pool, { tenantId: "", userId: "", roles: [] }, async (client) => {
      const result = await client.query(`select * from mathpilot_pending_review_feedback_commands()`);
      return result.rows as Array<{
        command_id: string;
        tenant_id: string;
        owner_user_id: string;
        candidate_set_id: string;
        target_thread_id: string;
        phase: Phase;
        annotations: Array<{ revision_id: string; revision_item_id: string | null; field_name: string | null; comment_text: string }>;
        attempt_count: number;
      }>;
    });
  }

  async markFeedbackAttempt(commandId: string, tenantId: string, ownerUserId: string, error: string): Promise<void> {
    await withPrincipal(this.pool, { tenantId, userId: ownerUserId, roles: ["teacher"] }, async (client) => {
      await client.query(
        `update content_review_decision
            set feedback_attempt_count=feedback_attempt_count+1,
                feedback_last_error=$2,
                feedback_next_attempt_at=now()+least(interval '10 minutes', interval '5 seconds' * power(2, least(feedback_attempt_count, 7)))
          where decision_id=$1 and decision='changes_requested' and feedback_dispatched_at is null`,
        [commandId, error],
      );
    });
  }

  async markFeedbackDispatched(commandId: string, tenantId: string, ownerUserId: string): Promise<void> {
    await withPrincipal(this.pool, { tenantId, userId: ownerUserId, roles: ["teacher"] }, async (client) => {
      await client.query(
        `update content_review_decision
            set feedback_dispatched_at=now(),feedback_last_error=null
          where decision_id=$1 and decision='changes_requested' and feedback_dispatched_at is null`,
        [commandId],
      );
    });
  }

  private mapSummary(row: CandidateSummary): CandidateSummary {
    // pg returns timestamp columns as Date objects at runtime, while the
    // lightweight row shape above intentionally keeps the transport type
    // string-based.  Avoid an `instanceof` check here so the generic row type
    // remains usable with both pg and test doubles.
    const created = row.created_at as unknown;
    const decided = row.decided_at as unknown;
    return {
      candidate_set_id: row.candidate_set_id,
      phase: row.phase,
      owner_teacher_user_id: row.owner_teacher_user_id,
      thread_id: row.thread_id,
      sequence_no: Number(row.sequence_no),
      status: row.status,
      item_count: Number(row.item_count ?? 0),
      display_name: row.display_name ?? null,
      created_at: created instanceof Date ? created.toISOString() : String(created),
      decided_at: decided instanceof Date ? decided.toISOString() : (decided == null ? null : String(decided)),
    };
  }
}

async function createReadyPackage(client: pg.PoolClient, principal: Principal, candidateSetId: string): Promise<string> {
  const candidate = await client.query<{ owner_teacher_user_id: string; phase: Phase; input_candidate_set_id: string | null }>(`select owner_teacher_user_id,phase,input_candidate_set_id from content_candidate_set where tenant_id=$1 and candidate_set_id=$2`, [principal.tenantId, candidateSetId]);
  if (candidate.rows[0]?.phase !== "er" || candidate.rows[0].owner_teacher_user_id !== principal.userId) throw new Error("only the ER owner can create a package");
  const ktqCandidateSetId = candidate.rows[0].input_candidate_set_id;
  if (!ktqCandidateSetId) throw new Error("ER candidate has no approved KTQ input");
  // PostgreSQL does not allow FOR UPDATE on an aggregate.  Serialize the
  // version allocation explicitly, then read the aggregate under that lock.
  await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [`package-version:${principal.tenantId}:${principal.userId}`]);
  const version = await client.query<{ version_no: number }>(`select coalesce(max(version_no),0)+1 as version_no from content_package where tenant_id=$1 and owner_teacher_user_id=$2`, [principal.tenantId, principal.userId]);
  const packageId = newId("pkg");
  const revisions = await client.query<{ revision_id: string }>(
    `select revision_id from (
       select revision_id,0 as phase_order,item_order
         from content_candidate_set_item where tenant_id=$1 and candidate_set_id=$2
       union all
       select revision_id,1 as phase_order,item_order
         from content_candidate_set_item where tenant_id=$1 and candidate_set_id=$3
     ) package_revisions order by phase_order,item_order`,
    [principal.tenantId, ktqCandidateSetId, candidateSetId],
  );
  if (!revisions.rows.length) throw new Error("KTQ/ER candidates have no revisions");
  await client.query(
    `insert into content_package(package_id,tenant_id,origin,owner_teacher_user_id,title,version_no,status,approved_er_candidate_set_id)
     values ($1,$2,'teacher',$3,$4,$5,'ready',$6)`,
    [packageId, principal.tenantId, principal.userId, `MathPilot 内容包 ${version.rows[0]?.version_no ?? 1}`, Number(version.rows[0]?.version_no ?? 1), candidateSetId],
  );
  for (const [index, revision] of revisions.rows.entries()) {
    await client.query(`insert into content_package_item(tenant_id,package_id,revision_id,item_order) values ($1,$2,$3,$4)`, [principal.tenantId, packageId, revision.revision_id, index]);
  }
  return packageId;
}
