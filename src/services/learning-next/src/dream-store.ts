import { createHash } from "node:crypto";
import pg from "pg";
import { digestJson, encodeArtifact, verifiedArtifactPayload } from "./artifact-integrity.ts";
import {
  DEEP_COMPILER_VERSION,
  DEEP_GATE_POLICY_VERSION,
  LIGHT_COMPILER_VERSION,
  REM_COMPILER_VERSION,
  gateRemCandidate,
  parseAnnotationChangeSet,
  parseLightAtomProposal,
  parseRemOutput,
  type AnnotationChangeSet,
  type AnnotationDraft,
  type RemGateResult,
  type WindowAtom,
} from "./dream-core.ts";
import type {
  BeginDreamRunInput,
  CommitDreamRunInput,
  DreamPhase,
  DreamRunCommitResult,
  FailDreamRunInput,
  RollbackAnnotationChangeSetInput,
  RollbackAnnotationChangeSetResult,
  ScheduledDreamEnqueueResult,
} from "./runtime-types.ts";

const idFrom = (prefix: string, value: string, length = 24): string =>
  `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0,length)}`;

const artifactIdFromRef = (ref: string): string => {
  const match = /^agent-artifact:(art_[A-Za-z0-9]{8,})$/.exec(ref);
  if (!match) throw new Error("Dream artifact reference is invalid");
  return match[1]!;
};

const objectValue = (value: unknown, name: string): Record<string,unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string,unknown>;
};

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

const unique = (values: readonly string[]): string[] => [...new Set(values)];
const toIso = (value: Date | string): string => new Date(value).toISOString();

interface DreamRunRow {
  dream_run_id: string;
  tenant_id: string;
  student_id: string;
  operation_id: string;
  source_event_id: string;
  phase: DreamPhase;
  window_ref: string;
  compiler_version: string;
  policy_version: string;
  input_artifact_id: string;
  output_artifact_id: string | null;
  status: "queued" | "running" | "completed" | "incomplete" | "rejected" | "stale" | "failed";
  started_at: Date | string | null;
}

interface CommitContext extends DreamRunRow {
  input_payload: unknown;
  input_sha256: string;
  output_payload: unknown;
  output_sha256: string;
  agent_attempt_id: string;
  resolved_model_id: string;
  prompt_version: string;
  skill_ref: string;
  attempt_completed_at: Date | string;
}

interface AtomRow {
  atom_id: string;
  student_id: string;
  question_session_id: string;
  dimension_revision_ids: string[];
  error_cause_revision_ids: string[];
  transfer_context: Record<string,string>;
  support_refs: string[];
  counter_refs: string[];
  source_refs: string[];
  summary: string;
  created_at: Date | string;
}

interface CandidateRow {
  rem_candidate_id: string;
  student_id: string;
  target_kind: "dimension" | "error_cause" | "student_trait" | "content_insight";
  target_ref: string;
  proposed_claim: string;
  proposed_scope: Record<string,string>;
  support_refs: string[];
  counter_refs: string[];
  contradictions: string[];
  actionability: string;
  gate_status: "accepted" | "rejected" | "review_required";
  reasons: string[];
  policy_version: string;
}

interface AnnotationRow {
  annotation_id: string;
  student_id: string;
  set_version: string;
  target_kind: "dimension" | "error_cause" | "student_trait";
  target_ref: string;
  claim: string;
  scope: Record<string,string>;
  support_refs: string[];
  counter_refs: string[];
  confidence: "low" | "medium" | "high";
  trend: "stable" | "improving" | "worsening" | "mixed" | "unknown" | null;
  action_hint: string | null;
  valid_from: Date | string;
  review_due_at: Date | string | null;
  change_set_id: string | null;
  dream_run_id: string | null;
  rollback_id: string | null;
}

export interface DreamStore {
  beginRun(input: BeginDreamRunInput): Promise<void>;
  commitLight(input: CommitDreamRunInput): Promise<DreamRunCommitResult>;
  commitRem(input: CommitDreamRunInput): Promise<DreamRunCommitResult>;
  commitDeep(input: CommitDreamRunInput): Promise<DreamRunCommitResult>;
  failRun(input: FailDreamRunInput): Promise<void>;
  enqueueScheduled(input: { tenantId: string; phase: "rem" | "deep"; scheduledAt: string }): Promise<ScheduledDreamEnqueueResult>;
  rollbackChangeSet(input: RollbackAnnotationChangeSetInput): Promise<RollbackAnnotationChangeSetResult>;
  close(): Promise<void>;
}

export class PostgresDreamStore implements DreamStore {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString,max: 6 });
  }

  private async withTenant<T>(tenantId: string, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query(
        "select set_config('app.current_tenant',$1,true),set_config('app.current_user','',true),set_config('app.current_roles','',true)",
        [tenantId],
      );
      const result = await fn(client);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async beginRun(input: BeginDreamRunInput): Promise<void> {
    const artifactId = artifactIdFromRef(input.inputRef);
    await this.withTenant(input.tenantId,async (client) => {
      const run = (await client.query<DreamRunRow>(
        `select * from science_v3_dream_run
          where tenant_id=$1 and operation_id=$2 and source_event_id=$3 and phase=$4
          for update`,
        [input.tenantId,input.operationId,input.eventId,input.phase],
      )).rows[0];
      if (!run || run.input_artifact_id !== artifactId) throw new Error("Dream Workflow does not match a queued DreamRun");
      if (run.status === "queued") {
        await client.query(
          `update science_v3_dream_run set status='running',started_at=clock_timestamp()
            where tenant_id=$1 and dream_run_id=$2 and status='queued'`,
          [input.tenantId,run.dream_run_id],
        );
      } else if (run.status !== "running" && !this.isTerminal(run.status)) {
        throw new Error("DreamRun is not runnable");
      }
    });
  }

  async commitLight(input: CommitDreamRunInput): Promise<DreamRunCommitResult> {
    return this.withTenant(input.tenantId,async (client) => {
      const context = await this.commitContext(client,input,"light");
      if (this.isTerminal(context.status)) return this.existingResult(client,context);
      const bundle = objectValue(context.input_payload,"Light input");
      const questionSessionId = String(bundle.question_session_id ?? "");
      const proposal = parseLightAtomProposal(context.output_payload,{
        dreamRunId: context.dream_run_id,
        studentId: context.student_id,
        questionSessionId,
      });
      const manifest = new Set(strings(bundle.source_manifest));
      if (proposal.source_refs.some((ref) => !manifest.has(ref))) throw new Error("Light output cites a source outside its frozen manifest");
      const frozen = objectValue(bundle.frozen_context,"Light frozen_context");
      const measurement = objectValue(frozen.measurement_contract,"Light measurement_contract");
      const allowedDimensions = new Set([
        ...strings(measurement.dimension_revision_ids),
        ...[...stringsFromFactSummaries(bundle.judgments,"dimension_revision_ids"),...stringsFromFactSummaries(bundle.observations,"dimension_revision_ids")],
      ]);
      const allowedErrors = new Set(stringsFromFactSummaries(bundle.error_evidence,"error_cause_revision_ids"));
      if (proposal.dimensions.some((id) => !allowedDimensions.has(id))
        || proposal.error_causes.some((id) => !allowedErrors.has(id))) {
        throw new Error("Light output introduces an unfrozen dimension or error-cause revision");
      }
      const atomId = idFrom("lat",`${context.dream_run_id}\0${LIGHT_COMPILER_VERSION}`);
      await client.query(
        `insert into science_v3_learning_evidence_atom(
           atom_id,tenant_id,student_id,question_session_id,dream_run_id,compiler_version,status,
           dimension_revision_ids,error_cause_revision_ids,observed_behaviors,method_signals,
           hint_dependency,self_correction,transfer_context,support_refs,counter_refs,
           unresolved_refs,source_refs,summary,agent_attempt_id,model_id,prompt_version,skill_ref,created_at
         ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
         on conflict (tenant_id,question_session_id,compiler_version) do nothing`,
        [atomId,input.tenantId,context.student_id,questionSessionId,context.dream_run_id,LIGHT_COMPILER_VERSION,
          proposal.status,proposal.dimensions,proposal.error_causes,proposal.observed_behaviors,proposal.method_signals,
          proposal.hint_dependency,proposal.self_correction,JSON.stringify(proposal.transfer_context),proposal.supports,
          proposal.counters,proposal.unresolved,proposal.source_refs,proposal.summary,context.agent_attempt_id,
          context.resolved_model_id,context.prompt_version,context.skill_ref,new Date(context.attempt_completed_at)],
      );
      const status = proposal.status === "ready" ? "completed" : "incomplete";
      await this.finishRun(client,context,input.outputRef,status,proposal.status === "ready" ? 1 : 0,proposal.status === "ready" ? 0 : 1,{
        inputRefs: strings(bundle.source_manifest),
        summary: proposal.summary,
      });
      if (proposal.status === "ready") await this.enqueueRem(client,input.tenantId,new Date().toISOString(),context.student_id);
      return { dreamRunId: context.dream_run_id,phase: "light",status,resourceRefs: [`light-atom://${atomId}`] };
    });
  }

  async commitRem(input: CommitDreamRunInput): Promise<DreamRunCommitResult> {
    return this.withTenant(input.tenantId,async (client) => {
      const context = await this.commitContext(client,input,"rem");
      if (this.isTerminal(context.status)) return this.existingResult(client,context);
      const bundle = objectValue(context.input_payload,"REM input");
      const windowId = String(bundle.window_id ?? "");
      const output = parseRemOutput(context.output_payload,{
        dreamRunId: context.dream_run_id,windowId,studentId: context.student_id,
      });
      const window = (await client.query<{ atom_ids: string[] }>(
        `select atom_ids from science_v3_rem_window
          where tenant_id=$1 and rem_window_id=$2 and dream_run_id=$3`,
        [input.tenantId,windowId,context.dream_run_id],
      )).rows[0];
      if (!window) throw new Error("REM window is missing");
      const atoms = (await client.query<AtomRow>(
        `select atom_id,student_id,question_session_id,dimension_revision_ids,error_cause_revision_ids,
                transfer_context,support_refs,counter_refs,source_refs,summary,created_at
           from science_v3_learning_evidence_atom
          where tenant_id=$1 and atom_id=any($2::text[]) and status='ready'`,
        [input.tenantId,window.atom_ids],
      )).rows;
      if (atoms.length !== window.atom_ids.length || atoms.some((atom) => atom.student_id !== context.student_id)) {
        throw new Error("REM window contains a missing or invalid Light atom");
      }
      const atomMap = new Map<string,WindowAtom>(atoms.map((atom) => [atom.atom_id,{
        atomId: atom.atom_id,
        questionSessionId: atom.question_session_id,
        dimensions: atom.dimension_revision_ids,
        errorCauses: atom.error_cause_revision_ids,
        context: atom.transfer_context,
        supports: atom.support_refs.length ? atom.support_refs : atom.source_refs,
        counters: atom.counter_refs,
      }]));
      const resourceRefs: string[] = [];
      let accepted = 0;
      let rejected = 0;
      for (const candidate of output.candidates) {
        const gate = gateRemCandidate(candidate,atomMap);
        const candidateId = idFrom("remc",`${context.dream_run_id}\0${candidate.candidate_id}`);
        const supportAtomIds = candidate.support_atom_refs.map((ref) => ref.slice("light-atom://".length));
        const counterAtomIds = candidate.counter_atom_refs.map((ref) => ref.slice("light-atom://".length));
        await client.query(
          `insert into science_v3_rem_theme_candidate(
             rem_candidate_id,tenant_id,student_id,dream_run_id,rem_window_id,model_candidate_id,
             target_kind,target_ref,proposed_claim,proposed_scope,support_atom_ids,counter_atom_ids,
             support_refs,counter_refs,contradictions,actionability,distinct_session_count,
             context_diversity,recency,source_trust,recommended_action
           ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
          [candidateId,input.tenantId,context.student_id,context.dream_run_id,windowId,candidate.candidate_id,
            candidate.target_kind,candidate.target_ref,candidate.proposed_claim,JSON.stringify(candidate.proposed_scope),
            supportAtomIds,counterAtomIds,gate.supportRefs,gate.counterRefs,candidate.contradictions,
            candidate.actionability,gate.distinctSessionCount,gate.contextDiversity,candidate.recency,
            candidate.source_trust,candidate.recommended_action],
        );
        const digest = digestJson({ candidate,gate });
        await client.query(
          `insert into science_v3_rem_candidate_gate(
             tenant_id,rem_candidate_id,gate_status,reasons,policy_version,evidence_digest
           ) values($1,$2,$3,$4,$5,$6)`,
          [input.tenantId,candidateId,gate.status,gate.reasons,DEEP_GATE_POLICY_VERSION,digest],
        );
        if (gate.status === "accepted") accepted += 1;
        else rejected += 1;
        if (gate.status === "review_required" && gate.supportRefs.length) {
          const reviewId = idFrom("arv",`${context.dream_run_id}\0${candidateId}`);
          await client.query(
            `insert into science_v3_annotation_review_proposal(
               review_proposal_id,tenant_id,student_id,dream_run_id,target_kind,target_ref,
               reason,support_refs,counter_refs
             ) values($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [reviewId,input.tenantId,context.student_id,context.dream_run_id,
              candidate.target_kind === "content_insight" ? "content_insight" : "student_trait",
              candidate.target_ref,gate.reasons.join("; ").slice(0,2000),gate.supportRefs,gate.counterRefs],
          );
          resourceRefs.push(`annotation-review://${reviewId}`);
        }
        resourceRefs.push(`rem-candidate://${candidateId}`);
      }
      const status = output.candidates.length ? "completed" : "incomplete";
      const inputRefs = strings(bundle.authorization_manifest);
      await this.finishRun(client,context,input.outputRef,status,accepted,rejected,{ inputRefs,summary: output.summary });
      await this.finishOperation(client,context,status,`rem-window:${windowId}`,1,resourceRefs);
      if (accepted) await this.enqueueDeep(client,input.tenantId,new Date().toISOString(),context.student_id);
      return { dreamRunId: context.dream_run_id,phase: "rem",status,resourceRefs: resourceRefs.slice(0,32) };
    });
  }

  async commitDeep(input: CommitDreamRunInput): Promise<DreamRunCommitResult> {
    return this.withTenant(input.tenantId,async (client) => {
      const context = await this.commitContext(client,input,"deep");
      if (this.isTerminal(context.status)) return this.existingResult(client,context);
      const bundle = objectValue(context.input_payload,"Deep input");
      const expectedVersion = Number(bundle.expected_annotation_set_version);
      const output = parseAnnotationChangeSet(context.output_payload,{
        dreamRunId: context.dream_run_id,
        studentId: context.student_id,
        annotationSetVersion: expectedVersion,
      });
      return this.commitDeepChangeSet(client,context,input,output,bundle);
    });
  }

  async failRun(input: FailDreamRunInput): Promise<void> {
    await this.withTenant(input.tenantId,async (client) => {
      const artifactId = artifactIdFromRef(input.inputRef);
      const run = (await client.query<DreamRunRow>(
        `select * from science_v3_dream_run
          where tenant_id=$1 and operation_id=$2 and source_event_id=$3 and phase=$4
          for update`,
        [input.tenantId,input.operationId,input.eventId,input.phase],
      )).rows[0];
      if (!run || run.input_artifact_id !== artifactId || this.isTerminal(run.status)) return;
      await client.query(
        `update science_v3_dream_run
            set status='failed',started_at=coalesce(started_at,clock_timestamp()),finished_at=clock_timestamp()
          where tenant_id=$1 and dream_run_id=$2 and status in('queued','running')`,
        [input.tenantId,run.dream_run_id],
      );
      await client.query(
        `insert into science_v3_dream_diary_entry(
           diary_entry_id,tenant_id,student_id,dream_run_id,phase,status,input_refs,
           rejected_count,rejection_reasons,summary,started_at,finished_at
         ) values($1,$2,$3,$4,$5,'failed',array[$6]::text[],1,array[$7]::text[],$7,$8,clock_timestamp())
         on conflict (tenant_id,dream_run_id) do nothing`,
        [idFrom("dia",run.dream_run_id),input.tenantId,run.student_id,run.dream_run_id,run.phase,input.inputRef,
          input.message.slice(0,2000) || "Dream task failed",run.started_at ? new Date(run.started_at) : new Date()],
      );
      if (input.phase !== "light") {
        await client.query(
          `update science_v3_operation
              set status=$3,user_message=$4,retryable=$5,updated_at=clock_timestamp(),version=version+1
            where tenant_id=$1 and operation_id=$2 and status in('accepted','running')`,
          [input.tenantId,input.operationId,input.cancelled ? "cancelled" : "failed",
            input.cancelled ? "Dream 整理已取消" : "Dream 整理失败，旧记忆保持不变",!input.cancelled],
        );
      }
    });
  }

  async enqueueScheduled(input: { tenantId: string; phase: "rem" | "deep"; scheduledAt: string }): Promise<ScheduledDreamEnqueueResult> {
    const scheduledAt = new Date(input.scheduledAt);
    if (!Number.isFinite(scheduledAt.valueOf())) throw new Error("scheduledAt is invalid");
    const enqueued = await this.withTenant(input.tenantId,(client) => input.phase === "rem"
      ? this.enqueueRem(client,input.tenantId,scheduledAt.toISOString())
      : this.enqueueDeep(client,input.tenantId,scheduledAt.toISOString()));
    return { phase: input.phase,enqueued };
  }

  private async commitContext(client: pg.PoolClient, input: CommitDreamRunInput, phase: DreamPhase): Promise<CommitContext> {
    const inputArtifactId = artifactIdFromRef(input.inputRef);
    const outputArtifactId = artifactIdFromRef(input.outputRef);
    const row = (await client.query<CommitContext>(
      `select run.*,input.payload as input_payload,input.sha256 as input_sha256,
              output.payload as output_payload,output.sha256 as output_sha256,
              attempt.agent_attempt_id,attempt.resolved_model_id,attempt.prompt_version,
              attempt.skill_ref,attempt.completed_at as attempt_completed_at
         from science_v3_dream_run run
         join science_v3_agent_artifact input
           on input.tenant_id=run.tenant_id and input.artifact_id=run.input_artifact_id
         join science_v3_agent_artifact output
           on output.tenant_id=run.tenant_id and output.artifact_id=$6
          and output.operation_id=run.operation_id and output.artifact_kind='structured_output'
         join science_v3_agent_attempt attempt
           on attempt.tenant_id=run.tenant_id and attempt.operation_id=run.operation_id
          and attempt.output_ref=$7 and attempt.status='succeeded'
        where run.tenant_id=$1 and run.operation_id=$2 and run.source_event_id=$3
          and run.phase=$4 and run.input_artifact_id=$5
        order by attempt.completed_at desc limit 1
        for update of run`,
      [input.tenantId,input.operationId,input.eventId,phase,inputArtifactId,outputArtifactId,input.outputRef],
    )).rows[0];
    if (!row || !row.resolved_model_id || !row.attempt_completed_at) throw new Error("Dream output is not bound to a completed AgentAttempt");
    verifiedArtifactPayload({ payload:row.input_payload,sha256:row.input_sha256 }, `${phase} Dream input`);
    verifiedArtifactPayload({ payload:row.output_payload,sha256:row.output_sha256 }, `${phase} Dream output`);
    if (row.status === "running") return row;
    if (this.isTerminal(row.status) && row.output_artifact_id === outputArtifactId) return row;
    throw new Error("DreamRun is not ready for commit");
  }

  private async finishRun(
    client: pg.PoolClient,
    context: CommitContext,
    outputRef: string,
    status: "completed" | "incomplete" | "rejected" | "stale",
    acceptedCount: number,
    rejectedCount: number,
    diary: { inputRefs: string[]; summary: string; rejectionReasons?: string[]; preimageRef?: string },
  ): Promise<void> {
    const outputArtifactId = artifactIdFromRef(outputRef);
    await client.query(
      `update science_v3_dream_run
          set status=$3,output_artifact_id=$4,accepted_count=$5,rejected_count=$6,
              model_id=$7,prompt_version=$8,skill_ref=$9,finished_at=clock_timestamp()
        where tenant_id=$1 and dream_run_id=$2 and status='running'`,
      [context.tenant_id,context.dream_run_id,status,outputArtifactId,acceptedCount,rejectedCount,
        context.resolved_model_id,context.prompt_version,context.skill_ref],
    );
    await client.query(
      `insert into science_v3_dream_diary_entry(
         diary_entry_id,tenant_id,student_id,dream_run_id,phase,status,input_refs,
         accepted_count,rejected_count,rejection_reasons,summary,preimage_ref,
         model_id,prompt_version,skill_ref,started_at,finished_at
       ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,clock_timestamp())
       on conflict (tenant_id,dream_run_id) do nothing`,
      [idFrom("dia",context.dream_run_id),context.tenant_id,context.student_id,context.dream_run_id,
        context.phase,status,unique(diary.inputRefs).slice(0,512),acceptedCount,rejectedCount,
        diary.rejectionReasons ?? [],diary.summary.slice(0,2000),diary.preimageRef ?? null,
        context.resolved_model_id,context.prompt_version,context.skill_ref,
        context.started_at ? new Date(context.started_at) : new Date()],
    );
  }

  private async finishOperation(
    client: pg.PoolClient,
    context: CommitContext,
    status: "completed" | "incomplete" | "rejected" | "stale",
    aggregateRef: string,
    aggregateVersion: number,
    resourceRefs: string[],
  ): Promise<void> {
    const rejected = status === "rejected" || status === "stale";
    await client.query(
      `insert into science_v3_operation_result(
         tenant_id,operation_id,idempotency_key,result_status,aggregate_ref,aggregate_version,
         result_resource_refs,rejection_code
       ) values($1,$2,$3,$4,$5,$6,$7,$8)
       on conflict (operation_id,idempotency_key) do nothing`,
      [context.tenant_id,context.operation_id,context.source_event_id,rejected ? "rejected" : "committed",
        aggregateRef,Math.max(1,aggregateVersion),unique(resourceRefs).slice(0,32),
        status === "stale" ? "version_conflict" : status === "rejected" ? "invalid_evidence" : null],
    );
    await client.query(
      `update science_v3_operation
          set status='succeeded',user_message=$3,retryable=false,related_resource_refs=$4,
              updated_at=clock_timestamp(),version=version+1
        where tenant_id=$1 and operation_id=$2 and status='running'`,
      [context.tenant_id,context.operation_id,
        status === "stale" ? "Dream 窗口已过期，旧记忆保持不变"
          : status === "rejected" ? "Dream 候选未通过校验，旧记忆保持不变"
            : status === "incomplete" ? "Dream 本轮证据不足，旧记忆保持不变" : "Dream 整理完成",
        unique(resourceRefs).slice(0,32)],
    );
  }

  private isTerminal(status: DreamRunRow["status"]): boolean {
    return ["completed","incomplete","rejected","stale","failed"].includes(status);
  }

  private async existingResult(client: pg.PoolClient, context: DreamRunRow): Promise<DreamRunCommitResult> {
    let refs: string[] = [];
    if (context.phase === "light") {
      refs = (await client.query<{ atom_id: string }>(
        `select atom_id from science_v3_learning_evidence_atom where tenant_id=$1 and dream_run_id=$2`,
        [context.tenant_id,context.dream_run_id],
      )).rows.map((row) => `light-atom://${row.atom_id}`);
    } else if (context.phase === "rem") {
      refs = (await client.query<{ rem_candidate_id: string }>(
        `select rem_candidate_id from science_v3_rem_theme_candidate where tenant_id=$1 and dream_run_id=$2 order by rem_candidate_id`,
        [context.tenant_id,context.dream_run_id],
      )).rows.map((row) => `rem-candidate://${row.rem_candidate_id}`);
    } else {
      refs = (await client.query<{ change_set_id: string }>(
        `select change_set_id from science_v3_annotation_change_set where tenant_id=$1 and dream_run_id=$2`,
        [context.tenant_id,context.dream_run_id],
      )).rows.map((row) => `annotation-change-set:${row.change_set_id}`);
    }
    const status = context.status === "completed" || context.status === "incomplete"
      || context.status === "rejected" || context.status === "stale" ? context.status : "incomplete";
    return { dreamRunId: context.dream_run_id,phase: context.phase,status,resourceRefs: refs.slice(0,32) };
  }

  private async soleTeacher(client: pg.PoolClient, tenantId: string): Promise<string | undefined> {
    const rows = (await client.query<{ user_id: string }>(
      `select user_id from identity_user_role
        where tenant_id=$1 and role='teacher' order by assigned_at,user_id limit 2`,
      [tenantId],
    )).rows;
    return rows.length === 1 ? rows[0]!.user_id : undefined;
  }

  private async activeAnnotations(client: pg.PoolClient, tenantId: string, studentId: string): Promise<AnnotationRow[]> {
    return (await client.query<AnnotationRow>(
      `select annotation.annotation_id,annotation.student_id,annotation.set_version,
              annotation.target_kind,annotation.target_ref,annotation.claim,annotation.scope,
              annotation.support_refs,annotation.counter_refs,annotation.confidence,annotation.trend,
              annotation.action_hint,annotation.valid_from,annotation.review_due_at,
              annotation.change_set_id,annotation.dream_run_id,annotation.rollback_id
         from science_v3_semantic_annotation annotation
        where annotation.tenant_id=$1 and annotation.student_id=$2
          and not exists(select 1 from science_v3_annotation_supersession supersession
                          where supersession.tenant_id=annotation.tenant_id
                            and supersession.superseded_annotation_id=annotation.annotation_id)
          and not exists(select 1 from science_v3_annotation_stale_fact stale
                          where stale.tenant_id=annotation.tenant_id and stale.annotation_id=annotation.annotation_id)
          and coalesce((select preference.enabled from science_v3_annotation_usage_preference_event preference
                         where preference.tenant_id=annotation.tenant_id and preference.student_id=annotation.student_id
                           and preference.annotation_id=annotation.annotation_id
                         order by preference.created_at desc,preference.preference_event_id desc limit 1),true)
          and coalesce((select preference.enabled from science_v3_annotation_usage_preference_event preference
                         where preference.tenant_id=annotation.tenant_id and preference.student_id=annotation.student_id
                           and preference.annotation_id is null
                         order by preference.created_at desc,preference.preference_event_id desc limit 1),true)
        order by annotation.set_version desc,annotation.annotation_id limit 64`,
      [tenantId,studentId],
    )).rows;
  }

  private annotationSummary(row: AnnotationRow): { resource_ref: string; summary: string } {
    return {
      resource_ref: `annotation://${row.annotation_id}`,
      summary: `${row.target_kind} ${row.target_ref}: ${row.claim}`.slice(0,2000),
    };
  }

  private async enqueueRem(client: pg.PoolClient, tenantId: string, scheduledAt: string, onlyStudentId?: string): Promise<number> {
    const teacherId = await this.soleTeacher(client,tenantId);
    if (!teacherId) return 0;
    const topics = (await client.query<{ student_id: string; topic_key: string }>(
      `select atom.student_id,
              coalesce(atom.dimension_revision_ids[1],atom.error_cause_revision_ids[1],'general') as topic_key
         from science_v3_learning_evidence_atom atom
        where atom.tenant_id=$1 and atom.status='ready'
          and ($2::text is null or atom.student_id=$2)
          and not exists(select 1 from science_v3_rem_window rem_window
                          where rem_window.tenant_id=atom.tenant_id and atom.atom_id=any(rem_window.atom_ids))
        group by atom.student_id,coalesce(atom.dimension_revision_ids[1],atom.error_cause_revision_ids[1],'general')
       having count(*)>=3 order by atom.student_id,topic_key limit 32`,
      [tenantId,onlyStudentId ?? null],
    )).rows;
    let enqueued = 0;
    for (const topic of topics) {
      const atoms = (await client.query<AtomRow>(
        `select atom_id,student_id,question_session_id,dimension_revision_ids,error_cause_revision_ids,
                transfer_context,support_refs,counter_refs,source_refs,summary,created_at
           from science_v3_learning_evidence_atom atom
          where atom.tenant_id=$1 and atom.student_id=$2 and atom.status='ready'
            and coalesce(atom.dimension_revision_ids[1],atom.error_cause_revision_ids[1],'general')=$3
            and not exists(select 1 from science_v3_rem_window rem_window
                            where rem_window.tenant_id=atom.tenant_id and atom.atom_id=any(rem_window.atom_ids))
          order by atom.created_at,atom.atom_id limit 64 for update of atom skip locked`,
        [tenantId,topic.student_id,topic.topic_key],
      )).rows;
      if (new Set(atoms.map((atom) => atom.question_session_id)).size < 3) continue;
      const atomIds = atoms.map((atom) => atom.atom_id);
      const identity = `${tenantId}\0${topic.student_id}\0${topic.topic_key}\0${atomIds.join(",")}\0${REM_COMPILER_VERSION}`;
      const operationId = idFrom("op",identity);
      const eventId = idFrom("evt",identity);
      const artifactId = idFrom("art",identity);
      const dreamRunId = idFrom("drm",identity);
      const windowId = idFrom("rwin",identity);
      await client.query(
        `insert into science_v3_annotation_set_head(tenant_id,student_id,version)
         values($1,$2,0) on conflict (tenant_id,student_id) do nothing`,
        [tenantId,topic.student_id],
      );
      const version = Number((await client.query<{ version: string }>(
        `select version from science_v3_annotation_set_head where tenant_id=$1 and student_id=$2`,
        [tenantId,topic.student_id],
      )).rows[0]?.version ?? 0);
      const annotations = await this.activeAnnotations(client,tenantId,topic.student_id);
      const scientificState = await this.scientificSummaries(client,tenantId,topic.student_id);
      const openedAt = toIso(atoms[0]!.created_at);
      const closedAt = toIso(atoms.at(-1)!.created_at);
      const contextDiversity = Math.max(1,new Set(atoms.flatMap((atom) =>
        Object.entries(atom.transfer_context).map(([key,value]) => `${key}=${value}`))).size);
      const atomBundles = atoms.map((atom) => ({
        atom_ref: `light-atom://${atom.atom_id}`,
        question_session_ref: `question-session://${atom.question_session_id}`,
        dimensions: atom.dimension_revision_ids,
        error_causes: atom.error_cause_revision_ids,
        supports: atom.support_refs,
        counters: atom.counter_refs,
        summary: atom.summary,
        context: atom.transfer_context,
        created_at: toIso(atom.created_at),
      }));
      const authorizationManifest = unique([
        ...atomBundles.map((atom) => atom.atom_ref),
        ...atoms.flatMap((atom) => atom.source_refs),
        ...scientificState.map((state) => state.resource_ref),
        ...annotations.map((annotation) => `annotation://${annotation.annotation_id}`),
      ]).slice(0,512);
      const payload = {
        schema_version: 3,
        compiler_version: REM_COMPILER_VERSION,
        dream_run_id: dreamRunId,
        window_id: windowId,
        student_id: topic.student_id,
        topic_key: topic.topic_key,
        annotation_set_version: version,
        light_atoms: atomBundles,
        scientific_state: scientificState,
        current_annotations: annotations.map((annotation) => this.annotationSummary(annotation)),
        authorization_manifest: authorizationManifest,
        window: {
          opened_at: openedAt,closed_at: closedAt,
          distinct_session_count: new Set(atoms.map((atom) => atom.question_session_id)).size,
          context_diversity: contextDiversity,
        },
        history_is_untrusted_data: true,
      };
      const artifact = encodeArtifact(payload);
      await client.query(
        `insert into science_v3_operation(operation_id,tenant_id,requested_by_user_id,kind,status,user_message)
         values($1,$2,$3,'dream','accepted','REM 整理已排队') on conflict (operation_id) do nothing`,
        [operationId,tenantId,teacherId],
      );
      await client.query(
        `insert into science_v3_agent_artifact(
           artifact_id,tenant_id,operation_id,artifact_kind,schema_uri,payload,sha256
         ) values($1,$2,$3,'input_bundle','https://schemas.mathpilot.dev/science-v3/rem-input/v1',$4::jsonb,$5)
         on conflict (artifact_id) do nothing`,
        [artifactId,tenantId,operationId,artifact.json,artifact.sha256],
      );
      await client.query(
        `insert into infra_outbox(
           event_id,tenant_id,aggregate_type,aggregate_id,event_type,payload,correlation_id,
           occurred_at,aggregate_version,payload_ref,operation_id
         ) values($1,$2,'dream-rem-window',$3,'dream.rem_requested','{}'::jsonb,$4,$5,1,$6,$4)
         on conflict (event_id) do nothing`,
        [eventId,tenantId,windowId,operationId,new Date(scheduledAt),`agent-artifact:${artifactId}`],
      );
      const inserted = await client.query(
        `insert into science_v3_dream_run(
           dream_run_id,tenant_id,student_id,operation_id,source_event_id,phase,window_ref,
           compiler_version,policy_version,input_artifact_id
         ) values($1,$2,$3,$4,$5,'rem',$6,$7,$8,$9)
         on conflict (tenant_id,phase,window_ref,compiler_version) do nothing returning 1`,
        [dreamRunId,tenantId,topic.student_id,operationId,eventId,`rem-window:${windowId}`,
          REM_COMPILER_VERSION,DEEP_GATE_POLICY_VERSION,artifactId],
      );
      await client.query(
        `insert into science_v3_rem_window(
           rem_window_id,tenant_id,student_id,dream_run_id,topic_key,atom_ids,
           annotation_set_version,authorization_manifest,window_opened_at,window_closed_at,context_diversity
         ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         on conflict (tenant_id,dream_run_id) do nothing`,
        [windowId,tenantId,topic.student_id,dreamRunId,topic.topic_key,atomIds,version,
          authorizationManifest,new Date(openedAt),new Date(closedAt),contextDiversity],
      );
      if (inserted.rowCount) enqueued += 1;
    }
    return enqueued;
  }

  private async enqueueDeep(client: pg.PoolClient, tenantId: string, scheduledAt: string, onlyStudentId?: string): Promise<number> {
    const teacherId = await this.soleTeacher(client,tenantId);
    if (!teacherId) return 0;
    const students = (await client.query<{ student_id: string }>(
      `select distinct candidate.student_id
         from science_v3_rem_theme_candidate candidate
         join science_v3_rem_candidate_gate gate
           on gate.tenant_id=candidate.tenant_id and gate.rem_candidate_id=candidate.rem_candidate_id
        where candidate.tenant_id=$1 and gate.gate_status='accepted'
          and ($2::text is null or candidate.student_id=$2)
          and not exists(select 1 from science_v3_deep_window deep_window
                          where deep_window.tenant_id=candidate.tenant_id
                            and candidate.rem_candidate_id=any(deep_window.rem_candidate_ids))
        order by candidate.student_id limit 32`,
      [tenantId,onlyStudentId ?? null],
    )).rows;
    let enqueued = 0;
    for (const student of students) {
      const candidates = (await client.query<CandidateRow>(
        `select candidate.rem_candidate_id,candidate.student_id,candidate.target_kind,candidate.target_ref,
                candidate.proposed_claim,candidate.proposed_scope,candidate.support_refs,candidate.counter_refs,
                candidate.contradictions,candidate.actionability,gate.gate_status,gate.reasons,gate.policy_version
           from science_v3_rem_theme_candidate candidate
           join science_v3_rem_candidate_gate gate
             on gate.tenant_id=candidate.tenant_id and gate.rem_candidate_id=candidate.rem_candidate_id
          where candidate.tenant_id=$1 and candidate.student_id=$2 and gate.gate_status='accepted'
            and candidate.target_kind in('dimension','error_cause')
            and not exists(select 1 from science_v3_deep_window deep_window
                            where deep_window.tenant_id=candidate.tenant_id
                              and candidate.rem_candidate_id=any(deep_window.rem_candidate_ids))
          order by candidate.created_at,candidate.rem_candidate_id limit 32
          for update of candidate skip locked`,
        [tenantId,student.student_id],
      )).rows;
      const effective: CandidateRow[] = [];
      for (const candidate of candidates) {
        if (!(await this.invalidEvidenceRefs(client,tenantId,[...candidate.support_refs,...candidate.counter_refs])).length) {
          effective.push(candidate);
        }
      }
      if (!effective.length) continue;
      await client.query(
        `insert into science_v3_annotation_set_head(tenant_id,student_id,version)
         values($1,$2,0) on conflict (tenant_id,student_id) do nothing`,
        [tenantId,student.student_id],
      );
      const version = Number((await client.query<{ version: string }>(
        `select version from science_v3_annotation_set_head where tenant_id=$1 and student_id=$2`,
        [tenantId,student.student_id],
      )).rows[0]!.version);
      const policy = (await client.query<{ write_budget: Record<string,number> }>(
        `select write_budget from science_v3_dream_policy where policy_version=$1 and active`,
        [DEEP_GATE_POLICY_VERSION],
      )).rows[0];
      if (!policy) throw new Error("active Deep gate policy is missing");
      const candidateIds = effective.map((candidate) => candidate.rem_candidate_id);
      const identity = `${tenantId}\0${student.student_id}\0${candidateIds.join(",")}\0${version}\0${DEEP_COMPILER_VERSION}`;
      const operationId = idFrom("op",identity);
      const eventId = idFrom("evt",identity);
      const artifactId = idFrom("art",identity);
      const dreamRunId = idFrom("drm",identity);
      const windowId = idFrom("dwin",identity);
      const annotations = await this.activeAnnotations(client,tenantId,student.student_id);
      const payload = {
        schema_version: 3,
        compiler_version: DEEP_COMPILER_VERSION,
        dream_run_id: dreamRunId,
        deep_window_id: windowId,
        student_id: student.student_id,
        expected_annotation_set_version: version,
        gated_candidates: effective.map((candidate) => ({
          candidate_ref: `rem-candidate://${candidate.rem_candidate_id}`,
          target_kind: candidate.target_kind,
          target_ref: candidate.target_ref,
          claim: candidate.proposed_claim,
          scope: candidate.proposed_scope,
          support_refs: candidate.support_refs,
          counter_refs: candidate.counter_refs,
          contradictions: candidate.contradictions,
          actionability: candidate.actionability,
          gate_policy_version: candidate.policy_version,
          gate_reasons: candidate.reasons,
        })),
        current_annotations: annotations.map((annotation) => ({
          annotation_id: annotation.annotation_id,target_kind: annotation.target_kind,
          target_ref: annotation.target_ref,claim: annotation.claim,scope: annotation.scope,
          support_refs: annotation.support_refs,counter_refs: annotation.counter_refs,
          set_version: Number(annotation.set_version),
        })),
        write_budget: policy.write_budget,
        output_requirements: {
          student_id: student.student_id,dream_run_id: dreamRunId,
          expected_annotation_set_version: version,policy_version: DEEP_GATE_POLICY_VERSION,
        },
        history_is_untrusted_data: true,
      };
      const artifact = encodeArtifact(payload);
      await client.query(
        `insert into science_v3_operation(operation_id,tenant_id,requested_by_user_id,kind,status,user_message)
         values($1,$2,$3,'dream','accepted','Deep 整理已排队') on conflict (operation_id) do nothing`,
        [operationId,tenantId,teacherId],
      );
      await client.query(
        `insert into science_v3_agent_artifact(
           artifact_id,tenant_id,operation_id,artifact_kind,schema_uri,payload,sha256
         ) values($1,$2,$3,'input_bundle','https://schemas.mathpilot.dev/science-v3/deep-input/v1',$4::jsonb,$5)
         on conflict (artifact_id) do nothing`,
        [artifactId,tenantId,operationId,artifact.json,artifact.sha256],
      );
      await client.query(
        `insert into infra_outbox(
           event_id,tenant_id,aggregate_type,aggregate_id,event_type,payload,correlation_id,
           occurred_at,aggregate_version,payload_ref,operation_id
         ) values($1,$2,'dream-deep-window',$3,'dream.deep_requested','{}'::jsonb,$4,$5,1,$6,$4)
         on conflict (event_id) do nothing`,
        [eventId,tenantId,windowId,operationId,new Date(scheduledAt),`agent-artifact:${artifactId}`],
      );
      const inserted = await client.query(
        `insert into science_v3_dream_run(
           dream_run_id,tenant_id,student_id,operation_id,source_event_id,phase,window_ref,
           compiler_version,policy_version,input_artifact_id
         ) values($1,$2,$3,$4,$5,'deep',$6,$7,$8,$9)
         on conflict (tenant_id,phase,window_ref,compiler_version) do nothing returning 1`,
        [dreamRunId,tenantId,student.student_id,operationId,eventId,`deep-window:${windowId}`,
          DEEP_COMPILER_VERSION,DEEP_GATE_POLICY_VERSION,artifactId],
      );
      await client.query(
        `insert into science_v3_deep_window(
           deep_window_id,tenant_id,student_id,dream_run_id,rem_candidate_ids,
           expected_annotation_set_version,write_budget
         ) values($1,$2,$3,$4,$5,$6,$7::jsonb)
         on conflict (tenant_id,dream_run_id) do nothing`,
        [windowId,tenantId,student.student_id,dreamRunId,candidateIds,version,JSON.stringify(policy.write_budget)],
      );
      if (inserted.rowCount) enqueued += 1;
    }
    return enqueued;
  }

  private async scientificSummaries(
    client: pg.PoolClient,tenantId: string,studentId: string,
  ): Promise<Array<{ resource_ref: string; summary: string }>> {
    const mastery = (await client.query<{ dimension_id: string; lineage_version: string; state: string; p_mastery: string }>(
      `select dimension_id,lineage_version,state,p_mastery from science_v3_mastery_projection
        where tenant_id=$1 and student_id=$2 order by dimension_id limit 96`,[tenantId,studentId],
    )).rows.map((row) => ({
      resource_ref: `mastery-projection://${studentId}/${row.dimension_id}/${row.lineage_version}`,
      summary: `${row.state}; p=${Number(row.p_mastery).toFixed(3)}`,
    }));
    const retention = (await client.query<{ retention_unit_revision_id: string; card_state: string; due_at: Date | string }>(
      `select retention_unit_revision_id,card_state,due_at from science_v3_retention_projection
        where tenant_id=$1 and student_id=$2 order by due_at limit 80`,[tenantId,studentId],
    )).rows.map((row) => ({
      resource_ref: `retention-projection://${studentId}/${row.retention_unit_revision_id}`,
      summary: `${row.card_state}; due ${toIso(row.due_at)}`,
    }));
    const errors = (await client.query<{ error_cause_id: string; state: string; support_count: number; counter_count: number }>(
      `select error_cause_id,state,support_count,counter_count from science_v3_error_pattern_projection
        where tenant_id=$1 and student_id=$2 and state<>'superseded' order by error_cause_id limit 80`,[tenantId,studentId],
    )).rows.map((row) => ({
      resource_ref: `error-pattern-projection://${studentId}/${row.error_cause_id}`,
      summary: `${row.state}; support ${row.support_count}; counter ${row.counter_count}`,
    }));
    return [...mastery,...retention,...errors].slice(0,256);
  }

  private async invalidEvidenceRefs(client: pg.PoolClient, tenantId: string, refs: readonly string[]): Promise<string[]> {
    const invalid: string[] = [];
    for (const ref of unique(refs)) {
      let exists = false;
      let match = /^attempt:\/\/(att_[A-Za-z0-9]{8,})$/.exec(ref);
      if (match) {
        exists = Boolean((await client.query(
          `select 1 from science_v3_attempt fact where fact.tenant_id=$1 and fact.attempt_id=$2
            and not exists(select 1 from science_v3_attempt newer
                            where newer.tenant_id=fact.tenant_id and newer.supersedes_attempt_id=fact.attempt_id)`,
          [tenantId,match[1]],
        )).rowCount);
      } else if ((match = /^judgment:\/\/(jdg_[A-Za-z0-9]{8,})$/.exec(ref))) {
        exists = Boolean((await client.query(
          `select 1 from science_v3_judgment fact join science_v3_attempt attempt
             on attempt.tenant_id=fact.tenant_id and attempt.attempt_id=fact.attempt_id
            where fact.tenant_id=$1 and fact.judgment_id=$2
              and not exists(select 1 from science_v3_judgment newer
                              where newer.tenant_id=fact.tenant_id and newer.supersedes_judgment_id=fact.judgment_id)
              and not exists(select 1 from science_v3_attempt newer_attempt
                              where newer_attempt.tenant_id=attempt.tenant_id
                                and newer_attempt.supersedes_attempt_id=attempt.attempt_id)`,
          [tenantId,match[1]],
        )).rowCount);
      } else if ((match = /^observation:\/\/(obs_[A-Za-z0-9]{8,})$/.exec(ref))) {
        exists = Boolean((await client.query(
          `select 1 from science_v3_observation fact join science_v3_judgment judgment
             on judgment.tenant_id=fact.tenant_id and judgment.judgment_id=fact.judgment_id
            where fact.tenant_id=$1 and fact.observation_id=$2
              and not exists(select 1 from science_v3_observation newer
                              where newer.tenant_id=fact.tenant_id and newer.supersedes_observation_id=fact.observation_id)
              and not exists(select 1 from science_v3_judgment newer_judgment
                              where newer_judgment.tenant_id=judgment.tenant_id
                                and newer_judgment.supersedes_judgment_id=judgment.judgment_id)`,
          [tenantId,match[1]],
        )).rowCount);
      } else if ((match = /^error-evidence:\/\/(eev_[A-Za-z0-9]{8,})$/.exec(ref))) {
        exists = Boolean((await client.query(
          `select 1 from science_v3_error_evidence fact
            where fact.tenant_id=$1 and fact.error_evidence_id=$2
              and not exists(select 1 from science_v3_error_evidence newer
                              where newer.tenant_id=fact.tenant_id
                                and newer.supersedes_error_evidence_id=fact.error_evidence_id)`,
          [tenantId,match[1]],
        )).rowCount);
      } else if (/^answer:\/\//.test(ref)) {
        exists = Boolean((await client.query(
          `select 1 from science_v3_attempt fact where fact.tenant_id=$1 and $2=any(fact.content_refs)
            and not exists(select 1 from science_v3_attempt newer
                            where newer.tenant_id=fact.tenant_id and newer.supersedes_attempt_id=fact.attempt_id)
            limit 1`,[tenantId,ref],
        )).rowCount);
      } else if ((match = /^mastery-projection:\/\/(stu_[A-Za-z0-9]{8,})\/([^/]+)\/([0-9]+)$/.exec(ref))) {
        exists = Boolean((await client.query(
          `select 1 from science_v3_mastery_projection
            where tenant_id=$1 and student_id=$2 and dimension_id=$3 and lineage_version=$4`,
          [tenantId,match[1],match[2],Number(match[3])],
        )).rowCount);
      } else if ((match = /^retention-projection:\/\/(stu_[A-Za-z0-9]{8,})\/([^/]+)$/.exec(ref))) {
        exists = Boolean((await client.query(
          `select 1 from science_v3_retention_projection
            where tenant_id=$1 and student_id=$2 and retention_unit_revision_id=$3`,
          [tenantId,match[1],match[2]],
        )).rowCount);
      } else if ((match = /^error-pattern-projection:\/\/(stu_[A-Za-z0-9]{8,})\/([^/]+)$/.exec(ref))) {
        exists = Boolean((await client.query(
          `select 1 from science_v3_error_pattern_projection
            where tenant_id=$1 and student_id=$2 and error_cause_id=$3 and state<>'superseded'`,
          [tenantId,match[1],match[2]],
        )).rowCount);
      }
      if (!exists) invalid.push(ref);
    }
    return invalid;
  }

  private async commitDeepChangeSet(
    client: pg.PoolClient,
    context: CommitContext,
    input: CommitDreamRunInput,
    output: AnnotationChangeSet,
    bundle: Record<string,unknown>,
  ): Promise<DreamRunCommitResult> {
    const windowId = String(bundle.deep_window_id ?? "");
    const window = (await client.query<{
      rem_candidate_ids: string[]; expected_annotation_set_version: string; write_budget: Record<string,number>;
    }>(
      `select rem_candidate_ids,expected_annotation_set_version,write_budget
         from science_v3_deep_window where tenant_id=$1 and deep_window_id=$2 and dream_run_id=$3`,
      [input.tenantId,windowId,context.dream_run_id],
    )).rows[0];
    if (!window) throw new Error("Deep window is missing");
    const sourceCandidateIds = output.source_refs.map((ref) => ref.slice("rem-candidate://".length));
    const sourceSet = new Set(window.rem_candidate_ids);
    const reasons: string[] = [];
    if (sourceCandidateIds.some((id) => !sourceSet.has(id))) reasons.push("ChangeSet cites a candidate outside its Deep window");
    const candidates = (await client.query<CandidateRow>(
      `select candidate.rem_candidate_id,candidate.student_id,candidate.target_kind,candidate.target_ref,
              candidate.proposed_claim,candidate.proposed_scope,candidate.support_refs,candidate.counter_refs,
              candidate.contradictions,candidate.actionability,gate.gate_status,gate.reasons,gate.policy_version
         from science_v3_rem_theme_candidate candidate join science_v3_rem_candidate_gate gate
           on gate.tenant_id=candidate.tenant_id and gate.rem_candidate_id=candidate.rem_candidate_id
        where candidate.tenant_id=$1 and candidate.rem_candidate_id=any($2::text[])`,
      [input.tenantId,sourceCandidateIds],
    )).rows;
    if (candidates.length !== sourceCandidateIds.length
      || candidates.some((candidate) => candidate.student_id !== context.student_id || candidate.gate_status !== "accepted")) {
      reasons.push("one or more Deep sources are missing, unauthorized or no longer gate-accepted");
    }
    const invalidRefs = await this.invalidEvidenceRefs(client,input.tenantId,candidates.flatMap((candidate) => [
      ...candidate.support_refs,...candidate.counter_refs,
    ]));
    if (invalidRefs.length) reasons.push(`source facts are no longer effective: ${invalidRefs.slice(0,8).join(", ")}`);
    const budget = window.write_budget;
    const additions = output.operations.filter((operation) => operation.op === "add").length;
    const supersessions = output.operations.filter((operation) => operation.op === "supersede").length;
    const reviews = output.operations.filter((operation) => operation.op === "propose_review").length;
    if (output.operations.length > Number(budget.maximum_operations ?? 0)
      || additions > Number(budget.maximum_additions ?? 0)
      || supersessions > Number(budget.maximum_supersessions ?? 0)
      || reviews > Number(budget.maximum_reviews ?? 0)) reasons.push("ChangeSet exceeds its frozen write budget");
    const active = await this.activeAnnotations(client,input.tenantId,context.student_id);
    const activeById = new Map(active.map((annotation) => [annotation.annotation_id,annotation]));
    const selectedCandidates = candidates.filter((candidate) => sourceCandidateIds.includes(candidate.rem_candidate_id));
    const allowedAllRefs = new Set(selectedCandidates.flatMap((candidate) => [...candidate.support_refs,...candidate.counter_refs]));
    for (const operation of output.operations) {
      if (operation.op === "add" || operation.op === "supersede") {
        const draft = operation.op === "add" ? operation.annotation : operation.replacement;
        const related = selectedCandidates.filter((candidate) =>
          candidate.target_kind === draft.target_kind && candidate.target_ref === draft.target_ref);
        if (!related.length) reasons.push(`Annotation target ${draft.target_ref} has no selected gated candidate`);
        const support = new Set(related.flatMap((candidate) => candidate.support_refs));
        const counter = new Set(related.flatMap((candidate) => candidate.counter_refs));
        if (draft.support_refs.some((ref) => !support.has(ref)) || draft.counter_refs.some((ref) => !counter.has(ref))) {
          reasons.push(`Annotation target ${draft.target_ref} cites evidence outside its gated candidate`);
        }
        if (!draft.counter_refs.length) reasons.push(`Annotation target ${draft.target_ref} has no explicit counterevidence`);
        if (draft.target_kind === "student_trait") reasons.push("high-risk student-trait claims require human review");
      }
      if (operation.op === "supersede" || operation.op === "keep") {
        if (!activeById.has(operation.annotation_id)) reasons.push(`Annotation ${operation.annotation_id} is not current`);
      }
      if (operation.op === "keep" && operation.evidence_refs.some((ref) => !allowedAllRefs.has(ref))) {
        reasons.push(`keep operation for ${operation.annotation_id} cites unauthorized evidence`);
      }
      if (operation.op === "propose_review"
        && [...operation.support_refs,...operation.counter_refs].some((ref) => !allowedAllRefs.has(ref))) {
        reasons.push(`review proposal ${operation.target_ref} cites unauthorized evidence`);
      }
    }
    await client.query(
      `insert into science_v3_annotation_set_head(tenant_id,student_id,version)
       values($1,$2,0) on conflict (tenant_id,student_id) do nothing`,
      [input.tenantId,context.student_id],
    );
    const head = (await client.query<{ version: string }>(
      `select version from science_v3_annotation_set_head
        where tenant_id=$1 and student_id=$2 for update`,[input.tenantId,context.student_id],
    )).rows[0]!;
    const currentVersion = Number(head.version);
    if (currentVersion !== Number(window.expected_annotation_set_version)) reasons.push("Annotation set version changed after Deep compilation");
    const status = currentVersion !== Number(window.expected_annotation_set_version) ? "stale" : reasons.length ? "rejected" : "completed";
    const changeSetId = idFrom("acs",context.dream_run_id);
    const existing = (await client.query<{ status: "committed" | "rejected" | "stale"; committed_set_version: string | null }>(
      `select status,committed_set_version from science_v3_annotation_change_set
        where tenant_id=$1 and dream_run_id=$2`,[input.tenantId,context.dream_run_id],
    )).rows[0];
    if (existing) {
      const priorStatus = existing.status === "committed" ? "completed" : existing.status;
      return { dreamRunId: context.dream_run_id,phase: "deep",status: priorStatus,resourceRefs: [`annotation-change-set:${changeSetId}`] };
    }
    if (status !== "completed") {
      await this.insertChangeSet(client,context,input,output,changeSetId,sourceCandidateIds,
        status === "stale" ? "stale" : "rejected",reasons,undefined,undefined,{});
      await this.finishRun(client,context,input.outputRef,status,0,reasons.length,{
        inputRefs: output.source_refs,summary: reasons.join("; ").slice(0,2000),rejectionReasons: reasons.slice(0,64),
      });
      await this.finishOperation(client,context,status,`deep-window:${windowId}`,Math.max(1,currentVersion),[`annotation-change-set:${changeSetId}`]);
      return { dreamRunId: context.dream_run_id,phase: "deep",status,resourceRefs: [`annotation-change-set:${changeSetId}`] };
    }
    const nextVersion = currentVersion+1;
    const affected = active.filter((annotation) => output.operations.some((operation) =>
      operation.op === "supersede" && operation.annotation_id === annotation.annotation_id));
    const preimage = affected.map((annotation) => annotationJson(annotation));
    const preimageArtifact = encodeArtifact(preimage);
    const preimageId = idFrom("pre",context.dream_run_id);
    await client.query(
      `insert into science_v3_annotation_preimage(
         preimage_id,tenant_id,student_id,annotation_set_version,annotations,sha256
       ) values($1,$2,$3,$4,$5::jsonb,$6)`,
      [preimageId,input.tenantId,context.student_id,currentVersion,preimageArtifact.json,preimageArtifact.sha256],
    );
    const addedIds: string[] = [];
    const supersededIds: string[] = [];
    const keptIds: string[] = [];
    const reviewIds: string[] = [];
    output.operations.forEach((operation,index) => {
      if (operation.op === "add" || operation.op === "supersede") addedIds.push(idFrom("ann",`${changeSetId}\0${index}`));
      if (operation.op === "supersede") supersededIds.push(operation.annotation_id);
      if (operation.op === "keep") keptIds.push(operation.annotation_id);
      if (operation.op === "propose_review") reviewIds.push(idFrom("arv",`${changeSetId}\0${index}`));
    });
    const diff = {
      model_change_set_id: output.change_set_id,
      added_annotation_ids: addedIds,
      superseded_annotation_ids: supersededIds,
      kept_annotation_ids: keptIds,
      review_proposal_ids: reviewIds,
    };
    await this.insertChangeSet(client,context,input,output,changeSetId,sourceCandidateIds,"committed",[],nextVersion,preimageId,diff);
    let addedIndex = 0;
    let reviewIndex = 0;
    for (const operation of output.operations) {
      if (operation.op === "add" || operation.op === "supersede") {
        const annotationId = addedIds[addedIndex++]!;
        const draft = operation.op === "add" ? operation.annotation : operation.replacement;
        await this.insertAnnotation(client,input.tenantId,context,changeSetId,annotationId,nextVersion,draft);
        if (operation.op === "supersede") {
          await client.query(
            `insert into science_v3_annotation_supersession(
               annotation_supersession_id,tenant_id,student_id,superseded_annotation_id,
               replacement_annotation_id,actor_kind,change_set_id,reason
             ) values($1,$2,$3,$4,$5,'deep',$6,$7)`,
            [idFrom("asup",`${changeSetId}\0${operation.annotation_id}`),input.tenantId,context.student_id,
              operation.annotation_id,annotationId,changeSetId,operation.reason],
          );
        }
      } else if (operation.op === "propose_review") {
        const reviewId = reviewIds[reviewIndex++]!;
        await client.query(
          `insert into science_v3_annotation_review_proposal(
             review_proposal_id,tenant_id,student_id,dream_run_id,change_set_id,target_kind,
             target_ref,reason,support_refs,counter_refs
           ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [reviewId,input.tenantId,context.student_id,context.dream_run_id,changeSetId,
            operation.target_kind,operation.target_ref,operation.reason,operation.support_refs,operation.counter_refs],
        );
      }
    }
    await client.query(
      `update science_v3_annotation_set_head set version=$3,updated_at=clock_timestamp()
        where tenant_id=$1 and student_id=$2 and version=$4`,
      [input.tenantId,context.student_id,nextVersion,currentVersion],
    );
    const refs = [`annotation-change-set:${changeSetId}`,
      ...addedIds.map((id) => `annotation://${id}`),...reviewIds.map((id) => `annotation-review://${id}`)];
    await this.finishRun(client,context,input.outputRef,"completed",output.operations.length,0,{
      inputRefs: output.source_refs,summary: `Committed ${addedIds.length} annotations, ${supersededIds.length} supersessions and ${reviewIds.length} reviews.`,
      preimageRef: `annotation-preimage:${preimageId}`,
    });
    await this.finishOperation(client,context,"completed",`deep-window:${windowId}`,nextVersion,refs);
    return { dreamRunId: context.dream_run_id,phase: "deep",status: "completed",resourceRefs: refs.slice(0,32) };
  }

  private async insertChangeSet(
    client: pg.PoolClient,context: CommitContext,input: CommitDreamRunInput,output: AnnotationChangeSet,
    changeSetId: string,sourceCandidateIds: string[],status: "committed" | "rejected" | "stale",
    rejectionReasons: string[],committedVersion: number | undefined,preimageId: string | undefined,diff: unknown,
  ): Promise<void> {
    await client.query(
      `insert into science_v3_annotation_change_set(
         change_set_id,tenant_id,student_id,dream_run_id,operation_id,output_artifact_id,
         expected_set_version,committed_set_version,status,rejection_reasons,operations,
         source_candidate_ids,preimage_id,diff,policy_version,agent_attempt_id,model_id,
         prompt_version,skill_ref,created_at
       ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14::jsonb,$15,$16,$17,$18,$19,$20)`,
      [changeSetId,input.tenantId,context.student_id,context.dream_run_id,context.operation_id,
        artifactIdFromRef(input.outputRef),output.expected_annotation_set_version,committedVersion ?? null,status,
        rejectionReasons.slice(0,64),JSON.stringify(output.operations),sourceCandidateIds,preimageId ?? null,
        JSON.stringify(diff),DEEP_GATE_POLICY_VERSION,context.agent_attempt_id,context.resolved_model_id,
        context.prompt_version,context.skill_ref,new Date(context.attempt_completed_at)],
    );
  }

  private async insertAnnotation(
    client: pg.PoolClient,tenantId: string,context: CommitContext,changeSetId: string,
    annotationId: string,setVersion: number,draft: AnnotationDraft,
  ): Promise<void> {
    await client.query(
      `insert into science_v3_semantic_annotation(
         annotation_id,tenant_id,student_id,set_version,target_kind,target_ref,claim,scope,
         support_refs,counter_refs,confidence,trend,action_hint,valid_from,review_due_at,
         change_set_id,dream_run_id
       ) values($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [annotationId,tenantId,context.student_id,setVersion,draft.target_kind,draft.target_ref,draft.claim,
        JSON.stringify(draft.scope),draft.support_refs,draft.counter_refs,draft.confidence,draft.trend ?? null,
        draft.action_hint ?? null,new Date(draft.valid_from),draft.review_due_at ? new Date(draft.review_due_at) : null,
        changeSetId,context.dream_run_id],
    );
  }

  async rollbackChangeSet(input: RollbackAnnotationChangeSetInput): Promise<RollbackAnnotationChangeSetResult> {
    if (!input.reason.trim() || input.reason.length > 1000) throw new Error("rollback reason must contain 1..1000 characters");
    return this.withTenant(input.tenantId,async (client) => {
      const change = (await client.query<{
        change_set_id: string; student_id: string; preimage_id: string; committed_set_version: string;
        annotations: unknown; annotation_set_version: string; sha256: string;
      }>(
        `select change.change_set_id,change.student_id,change.preimage_id,change.committed_set_version,
                preimage.annotations,preimage.annotation_set_version,preimage.sha256
           from science_v3_annotation_change_set change join science_v3_annotation_preimage preimage
             on preimage.tenant_id=change.tenant_id and preimage.preimage_id=change.preimage_id
          where change.tenant_id=$1 and change.change_set_id=$2 and change.status='committed'`,
        [input.tenantId,input.changeSetId],
      )).rows[0];
      if (!change) throw new Error("committed AnnotationChangeSet was not found");
      const teacher = await client.query(
        `select 1 from identity_user_role where tenant_id=$1 and user_id=$2 and role='teacher'`,
        [input.tenantId,input.actorUserId],
      );
      if (!teacher.rowCount) throw new Error("only the tenant teacher can rollback annotations");
      const verifiedPreimage = verifiedArtifactPayload(
        { payload:change.annotations,sha256:change.sha256 },
        "annotation preimage",
      );
      const existing = (await client.query<{
        rollback_id: string; from_set_version: string; to_set_version: string;
        restored_annotation_ids: string[]; retired_annotation_ids: string[];
      }>(
        `select rollback_id,from_set_version,to_set_version,restored_annotation_ids,retired_annotation_ids
           from science_v3_annotation_rollback where tenant_id=$1 and change_set_id=$2`,
        [input.tenantId,input.changeSetId],
      )).rows[0];
      if (existing) return {
        rollbackId: existing.rollback_id,studentId: change.student_id,
        fromSetVersion: Number(existing.from_set_version),toSetVersion: Number(existing.to_set_version),
        restoredAnnotationIds: existing.restored_annotation_ids,retiredAnnotationIds: existing.retired_annotation_ids,
      };
      const head = (await client.query<{ version: string }>(
        `select version from science_v3_annotation_set_head
          where tenant_id=$1 and student_id=$2 for update`,[input.tenantId,change.student_id],
      )).rows[0];
      if (!head || Number(head.version) !== Number(change.committed_set_version)) {
        throw new Error("only the latest AnnotationChangeSet can be rolled back without overwriting newer memory");
      }
      const fromVersion = Number(head.version);
      const toVersion = fromVersion+1;
      const rollbackId = idFrom("arb",input.changeSetId);
      const preimage = Array.isArray(verifiedPreimage)
        ? verifiedPreimage.map((item) => objectValue(item,"preimage annotation")) : [];
      const created = (await client.query<{ annotation_id: string }>(
        `select annotation.annotation_id from science_v3_semantic_annotation annotation
          where annotation.tenant_id=$1 and annotation.change_set_id=$2
            and not exists(select 1 from science_v3_annotation_supersession supersession
                            where supersession.tenant_id=annotation.tenant_id
                              and supersession.superseded_annotation_id=annotation.annotation_id)
          order by annotation.annotation_id`,[input.tenantId,input.changeSetId],
      )).rows.map((row) => row.annotation_id);
      const restored = preimage.map((annotation,index) => idFrom("ann",`${rollbackId}\0${index}\0${String(annotation.annotation_id ?? "")}`));
      await client.query(
        `insert into science_v3_annotation_rollback(
           rollback_id,tenant_id,student_id,change_set_id,preimage_id,actor_user_id,reason,
           from_set_version,to_set_version,restored_annotation_ids,retired_annotation_ids
         ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [rollbackId,input.tenantId,change.student_id,input.changeSetId,change.preimage_id,input.actorUserId,
          input.reason,fromVersion,toVersion,restored,created],
      );
      for (const [index,raw] of preimage.entries()) {
        const annotation = raw!;
        await client.query(
          `insert into science_v3_semantic_annotation(
             annotation_id,tenant_id,student_id,set_version,target_kind,target_ref,claim,scope,
             support_refs,counter_refs,confidence,trend,action_hint,valid_from,review_due_at,rollback_id
           ) values($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16)`,
          [restored[index],input.tenantId,change.student_id,toVersion,annotation.target_kind,annotation.target_ref,
            annotation.claim,JSON.stringify(annotation.scope ?? {}),strings(annotation.support_refs),strings(annotation.counter_refs),
            annotation.confidence,annotation.trend ?? null,annotation.action_hint ?? null,new Date(String(annotation.valid_from)),
            annotation.review_due_at ? new Date(String(annotation.review_due_at)) : null,rollbackId],
        );
      }
      for (const annotationId of created) {
        await client.query(
          `insert into science_v3_annotation_supersession(
             annotation_supersession_id,tenant_id,student_id,superseded_annotation_id,
             actor_kind,rollback_id,reason
           ) values($1,$2,$3,$4,'rollback',$5,$6)`,
          [idFrom("asup",`${rollbackId}\0retire\0${annotationId}`),input.tenantId,change.student_id,
            annotationId,rollbackId,input.reason],
        );
      }
      await client.query(
        `update science_v3_annotation_set_head set version=$3,updated_at=clock_timestamp()
          where tenant_id=$1 and student_id=$2 and version=$4`,
        [input.tenantId,change.student_id,toVersion,fromVersion],
      );
      return {
        rollbackId,studentId: change.student_id,fromSetVersion: fromVersion,toSetVersion: toVersion,
        restoredAnnotationIds: restored,retiredAnnotationIds: created,
      };
    });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

function stringsFromFactSummaries(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) return [];
  return unique(value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    return strings((item as Record<string,unknown>)[field]);
  }));
}

function annotationJson(annotation: AnnotationRow): Record<string,unknown> {
  return {
    annotation_id: annotation.annotation_id,
    target_kind: annotation.target_kind,
    target_ref: annotation.target_ref,
    claim: annotation.claim,
    scope: annotation.scope,
    support_refs: annotation.support_refs,
    counter_refs: annotation.counter_refs,
    confidence: annotation.confidence,
    ...(annotation.trend ? { trend: annotation.trend } : {}),
    ...(annotation.action_hint ? { action_hint: annotation.action_hint } : {}),
    valid_from: toIso(annotation.valid_from),
    ...(annotation.review_due_at ? { review_due_at: toIso(annotation.review_due_at) } : {}),
  };
}
