/** Pi 插件式结构化出口；不修改 Pi 本体。 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { configuredInternalService } from "@mathpilot/internal-service";
import { Type } from "typebox";
import { listBoundAttachments } from "./attachments/manifest.ts";
import { readHostPrincipal } from "./lib/host-principal.ts";
import { validateContentRespond } from "./lib/content-result-validation.ts";

type HostPrincipal = Awaited<ReturnType<typeof readHostPrincipal>>;

const normalizeInputReference = (value: string): string => {
  const normalized = path.posix.normalize(value.replaceAll("\\", "/"));
  return normalized.startsWith("input/") ? normalized : `input/${normalized}`;
};

async function sourceObjectsForResult(cwd: string, result: Record<string, unknown>): Promise<Array<{
  workspace_path: string;
  object_id: string;
  version_id: string;
  sha256: string;
}>> {
  const references = new Set<string>();
  if (result.schema === "mathpilot.ktq-result/v1" && Array.isArray(result.questions)) {
    for (const questionValue of result.questions) {
      if (!questionValue || typeof questionValue !== "object" || Array.isArray(questionValue)) continue;
      const question = questionValue as Record<string, unknown>;
      const source = question.source && typeof question.source === "object" && !Array.isArray(question.source)
        ? question.source as Record<string, unknown>
        : undefined;
      if (typeof source?.path === "string") references.add(normalizeInputReference(source.path));
      if (Array.isArray(question.image_refs)) {
        for (const value of question.image_refs) if (typeof value === "string") references.add(normalizeInputReference(value));
      }
    }
  }
  if (!references.size) return [];
  const attachments = await listBoundAttachments(cwd);
  const byPath = new Map(attachments.map((attachment) => [attachment.workspacePath, attachment]));
  return [...references].map((workspacePath) => {
    const attachment = byPath.get(workspacePath);
    if (!attachment) throw new Error(`validated source is not backed by a registered storage object: ${workspacePath}`);
    return {
      workspace_path: workspacePath,
      object_id: attachment.storageObjectId,
      version_id: attachment.versionId,
      sha256: attachment.sha256,
    };
  });
}

async function storeCandidateAuditFile(
  cwd: string,
  relativeFile: string,
  principal: NonNullable<HostPrincipal>,
  signal?: AbortSignal,
): Promise<{ objectId: string; sha256: string; versionId: string }> {
  const bytes = await readFile(path.resolve(cwd, relativeFile));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const internalService = configuredInternalService("pi-chat-runtime");
  const initialized = await internalService.request("pi-to-storage", principal, "/internal/objects/init", {
    method: "POST",
    json: {
      purpose: "candidate",
      mime_type: "application/json",
      byte_size: bytes.length,
      original_name: path.basename(relativeFile),
      audience: "runtime",
    },
    ...(signal ? { signal } : {}),
    timeoutMs: 30_000,
  });
  const initBody = await initialized.json().catch(() => ({})) as { object_id?: unknown; upload_url?: unknown };
  if (!initialized.ok || typeof initBody.object_id !== "string" || typeof initBody.upload_url !== "string") throw new Error(`candidate audit object init failed (${initialized.status})`);
  const uploaded = await fetch(initBody.upload_url, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: bytes,
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(5 * 60_000)])
      : AbortSignal.timeout(5 * 60_000),
  });
  if (!uploaded.ok) throw new Error(`candidate audit object upload failed (${uploaded.status})`);
  const completed = await internalService.request(
    "pi-to-storage",
    principal,
    `/internal/objects/${encodeURIComponent(initBody.object_id)}/complete`,
    {
      method: "POST",
      json: { sha256 },
      ...(signal ? { signal } : {}),
      timeoutMs: 5 * 60_000,
    },
  );
  const completeBody = await completed.json().catch(() => ({})) as { sha256?: unknown; version_id?: unknown };
  if (!completed.ok || completeBody.sha256 !== sha256 || typeof completeBody.version_id !== "string" || !completeBody.version_id) throw new Error(`candidate audit object verification failed (${completed.status})`);
  return { objectId: initBody.object_id, sha256, versionId: completeBody.version_id };
}

export default async (pi: ExtensionAPI) => {
  pi.registerTool({
    name: "respond",
    label: "Respond",
    description:
      "提交最终结果。KTQ/ER 必须引用已经由对应 Skill 验证的工作区文件；其他任务可使用 output。",
    parameters: Type.Object({
      output: Type.Optional(Type.Unknown()),
      result_file: Type.Optional(Type.String()),
      validation_file: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, context) {
      const principal = params.result_file || params.validation_file
        ? await readHostPrincipal(context.cwd)
        : undefined;
      if (principal && !principal.roles.includes("teacher")) {
        throw new Error("KTQ/ER content respond requires a teacher principal");
      }
      const validated = params.result_file || params.validation_file
        ? await validateContentRespond(context.cwd, params)
        : undefined;
      let registered: Record<string, unknown> | undefined;
      if (validated && principal) {
        const threadManifest = JSON.parse(await readFile(path.join(context.cwd, "input", "session", "thread.json"), "utf8")) as { thread_id?: unknown };
        if (typeof threadManifest.thread_id !== "string" || !threadManifest.thread_id) throw new Error("Pi thread manifest is missing");
        const result = JSON.parse(await readFile(path.resolve(context.cwd, validated.resultFile), "utf8")) as Record<string, unknown>;
        const sourceObjects = await sourceObjectsForResult(context.cwd, result);
        const frozen = validated.kind === "er"
          ? JSON.parse(await readFile(path.join(context.cwd, "input", "frozen", "ktq.json"), "utf8").catch(() => "{}")) as Record<string, unknown>
          : {};
        const [resultAudit, receiptAudit] = await Promise.all([
          storeCandidateAuditFile(context.cwd, validated.resultFile, principal, _signal),
          storeCandidateAuditFile(context.cwd, validated.validationFile, principal, _signal),
        ]);
        if (resultAudit.sha256 !== validated.sha256) throw new Error("stored result hash does not match validated result");
        const candidateBody = {
          phase: validated.kind,
          thread_id: threadManifest.thread_id,
          tool_call_id: _toolCallId,
          result_sha256: validated.sha256,
          result_object_id: resultAudit.objectId,
          receipt_object_id: receiptAudit.objectId,
          source_objects: sourceObjects,
          result,
          ...(typeof frozen.candidate_set_id === "string"
            ? { input_candidate_set_id: frozen.candidate_set_id }
            : {}),
          ...(typeof result.supersedes_candidate_set_id === "string"
            ? { supersedes_candidate_set_id: result.supersedes_candidate_set_id }
            : {}),
        };
        const response = await configuredInternalService("pi-chat-runtime").request(
          "pi-to-content",
          principal,
          "/internal/candidates/register",
          {
            method: "POST",
            json: candidateBody,
            ...(_signal ? { signal: _signal } : {}),
            timeoutMs: 30_000,
          },
        );
        const body = await response.json().catch(() => ({})) as Record<string, unknown>;
        if (!response.ok) throw new Error(`content candidate registration failed (${response.status}): ${String(body.detail ?? body.error ?? "unknown error")}`);
        const candidate = body.candidate && typeof body.candidate === "object" && !Array.isArray(body.candidate)
          ? body.candidate as Record<string, unknown>
          : {};
        registered = {
          ...body,
          ...(typeof candidate.candidate_set_id === "string" ? { candidate_set_id: candidate.candidate_set_id } : {}),
        };
      }
      const content = validated
        ? JSON.stringify({
            ...(registered ?? {}),
            schema: "mathpilot.content-respond/v1",
            kind: validated.kind,
            itemCount: validated.itemCount,
            resultFile: validated.resultFile,
            validationFile: validated.validationFile,
            sha256: validated.sha256,
          })
        : "responded";
      return {
        content: [{ type: "text", text: content }],
        details: registered ? { ...validated, ...registered } : validated ?? params,
        terminate: true,
      };
    },
  });
};
