/** Pi plugin structured exit; byte ownership stays in the shared integrity + Storage mechanisms. */
import { openAsBlob } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  type ImmutableObjectDescriptor,
} from "@mathpilot/content-integrity";
import type { SealedContent } from "@mathpilot/content-integrity/node";
import { publishStorageObject } from "@mathpilot/content-integrity/publication";
import { publicProblemMessage,readProblemDetails } from "@mathpilot/contracts";
import { configuredInternalService } from "@mathpilot/internal-service";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readHostPrincipal } from "./lib/host-principal.ts";
import {
  candidateSourceObjects,
  readHostSourceManifest,
} from "./lib/host-source-manifest.ts";
import { validateContentRespond, type ValidatedContentResult } from "./lib/content-result-validation.ts";

type HostPrincipal = Awaited<ReturnType<typeof readHostPrincipal>>;
type AuditPair = readonly [ImmutableObjectDescriptor, ImmutableObjectDescriptor];
type CandidateRegistration = {
  created: boolean;
  resultObjectId: string;
  receiptObjectId: string;
  resultSha256: string;
};

const objectValue = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const parseCandidateRegistration = (body: Record<string, unknown>): CandidateRegistration => {
  const value = objectValue(body.registration);
  if (
    !value
    || typeof value.created !== "boolean"
    || typeof value.result_object_id !== "string"
    || typeof value.receipt_object_id !== "string"
    || typeof value.result_sha256 !== "string"
    || !/^[0-9a-f]{64}$/.test(value.result_sha256)
  ) {
    throw new Error("content candidate registration response is missing its object claim receipt");
  }
  return {
    created: value.created,
    resultObjectId: value.result_object_id,
    receiptObjectId: value.receipt_object_id,
    resultSha256: value.result_sha256,
  };
};

export const candidateRegistrationDisposition = (
  body: Record<string, unknown>,
  audits: AuditPair,
  resultSha256: string,
): { claimed: boolean; replayed: boolean } => {
  const registration = parseCandidateRegistration(body);
  if (registration.resultSha256 !== resultSha256) {
    throw new Error("content candidate registration response changed the sealed result digest");
  }
  const claimed = registration.resultObjectId === audits[0].object_id
    && registration.receiptObjectId === audits[1].object_id;
  if (registration.created && !claimed) {
    throw new Error("content candidate registration claimed different audit objects");
  }
  return { claimed, replayed: !registration.created };
};

export async function candidateRegistrationResponseBody(response: Response): Promise<Record<string,unknown>> {
  if (!response.ok) {
    const problem = await readProblemDetails(response);
    throw new Error(
      `content candidate registration failed (${response.status}): ${problem ? publicProblemMessage(problem) : "request rejected"}`,
    );
  }
  return await response.json() as Record<string,unknown>;
}

async function removeUnclaimed(objectId: string, principal: HostPrincipal): Promise<void> {
  await configuredInternalService("pi-chat-runtime").request(
    "pi-to-storage",
    principal,
    `/internal/objects/${encodeURIComponent(objectId)}`,
    { method: "DELETE", timeoutMs: 10_000, signal: AbortSignal.timeout(10_000) },
  ).catch(() => undefined);
}

const removeUnclaimedPair = async (pair: AuditPair, principal: HostPrincipal): Promise<void> => {
  await Promise.all(pair.map((object) => removeUnclaimed(object.object_id, principal)));
};

async function storeCandidateAudit(
  sealed: SealedContent,
  originalName: string,
  principal: HostPrincipal,
  signal?: AbortSignal,
): Promise<ImmutableObjectDescriptor> {
  const runtime = configuredInternalService("pi-chat-runtime");
  return publishStorageObject({
    request: {
      purpose: "candidate",
      mime_type: sealed.stored.mimeType,
      byte_size: sealed.stored.byteSize,
      original_name: path.basename(originalName),
    },
    ...(signal ? { signal } : {}),
    expectedStored: sealed.stored,
    adapter: {
      async initialize(request,requestSignal) {
        const response = await runtime.request("pi-to-storage", principal, "/internal/objects/init", {
          method:"POST",json:request,signal:requestSignal,timeoutMs:30_000,
        });
        if (!response.ok) throw new Error(`candidate audit object init failed (${response.status})`);
        return response.json();
      },
      async upload(descriptor,requestSignal) {
        const form = new FormData();
        for (const [name,value] of Object.entries(descriptor.upload.fields)) form.append(name,value);
        form.append("file",await openAsBlob(sealed.storedPath,{ type:sealed.stored.mimeType }),path.basename(originalName));
        const response = await fetch(descriptor.upload.url,{ method:"POST",body:form,signal:requestSignal });
        if (!response.ok) throw new Error(`candidate audit object upload failed (${response.status})`);
      },
      async complete(objectId,requestSignal) {
        const response = await runtime.request(
          "pi-to-storage",principal,`/internal/objects/${encodeURIComponent(objectId)}/complete`,
          { method:"POST",json:{},signal:requestSignal,timeoutMs:5*60_000 },
        );
        if (!response.ok) throw new Error(`candidate audit object verification failed (${response.status})`);
        return response.json();
      },
      async removeUnclaimed(objectId) { await removeUnclaimed(objectId,principal); },
    },
  });
}

async function publishAuditPair(
  validated: ValidatedContentResult,
  principal: HostPrincipal,
  signal?: AbortSignal,
): Promise<AuditPair> {
  const results = await Promise.allSettled([
    storeCandidateAudit(validated.resultSealed, validated.resultFile, principal, signal),
    storeCandidateAudit(validated.receiptSealed, validated.validationFile, principal, signal),
  ]);
  const failure = results.find((value): value is PromiseRejectedResult => value.status === "rejected");
  if (failure) {
    await Promise.all(results.flatMap((value) => value.status === "fulfilled"
      ? [removeUnclaimed(value.value.object_id, principal)]
      : []));
    throw failure.reason;
  }
  return [
    (results[0] as PromiseFulfilledResult<ImmutableObjectDescriptor>).value,
    (results[1] as PromiseFulfilledResult<ImmutableObjectDescriptor>).value,
  ];
}

const publicValidationDetails = (validated: ValidatedContentResult): Record<string, unknown> => ({
  kind: validated.kind,
  schema: validated.schema,
  resultFile: validated.resultFile,
  validationFile: validated.validationFile,
  sha256: validated.sha256,
  itemCount: validated.itemCount,
});

export default async (pi: ExtensionAPI) => {
  pi.registerTool({
    name: "respond",
    label: "Respond",
    description: "提交最终结果。KTQ/ER 必须引用已经由对应 Skill 验证的工作区文件；其他任务可使用 output。",
    parameters: Type.Object({
      output: Type.Optional(Type.Unknown()),
      result_file: Type.Optional(Type.String()),
      validation_file: Type.Optional(Type.String()),
    }),
    async execute(toolCallId, params, signal, _onUpdate, context) {
      const contentSubmission = params.result_file !== undefined || params.validation_file !== undefined;
      const principal = contentSubmission ? await readHostPrincipal(context.cwd) : undefined;
      if (principal && !principal.roles.includes("teacher")) {
        throw new Error("KTQ/ER content respond requires a teacher principal");
      }
      const validated = contentSubmission
        ? await validateContentRespond(context.cwd, params)
        : undefined;
      let registered: Record<string, unknown> | undefined;
      try {
        if (validated && principal) {
          const threadManifest = JSON.parse(
            await readFile(path.join(context.cwd, "input/session/thread.json"), "utf8"),
          ) as { thread_id?: unknown };
          if (typeof threadManifest.thread_id !== "string" || !threadManifest.thread_id) {
            throw new Error("Pi thread manifest is missing");
          }
          const sources = candidateSourceObjects(
            validated.kind,
            validated.result,
            await readHostSourceManifest(context.cwd),
          );
          const frozen = validated.kind === "er"
            ? JSON.parse(
                await readFile(path.join(context.cwd, "input/frozen/ktq.json"), "utf8").catch(() => "{}"),
              ) as Record<string, unknown>
            : {};

          let audits: AuditPair | undefined;
          let claimed = false;
          try {
            audits = await publishAuditPair(validated, principal, signal);
            const [resultAudit, receiptAudit] = audits;
            const resultSha256 = validated.resultSealed.stored.sha256;
            if (resultAudit.sha256 !== resultSha256) {
              throw new Error("stored result hash does not match validated result");
            }
            const response = await configuredInternalService("pi-chat-runtime").request(
              "pi-to-content",
              principal,
              "/internal/candidates/register",
              {
                method: "POST",
                json: {
                  phase: validated.kind,
                  thread_id: threadManifest.thread_id,
                  tool_call_id: toolCallId,
                  result_sha256: resultSha256,
                  result_object_id: resultAudit.object_id,
                  receipt_object_id: receiptAudit.object_id,
                  source_objects: sources.map(({ workspace_path, descriptor }) => ({
                    workspace_path,
                    object_id: descriptor.object_id,
                    version_id: descriptor.version_id,
                    sha256: descriptor.sha256,
                  })),
                  result: validated.result,
                  ...(typeof frozen.candidate_set_id === "string"
                    ? { input_candidate_set_id: frozen.candidate_set_id }
                    : {}),
                  ...(typeof validated.result.supersedes_candidate_set_id === "string"
                    ? { supersedes_candidate_set_id: validated.result.supersedes_candidate_set_id }
                    : {}),
                },
                signal: signal
                  ? AbortSignal.any([signal,AbortSignal.timeout(30_000)])
                  : AbortSignal.timeout(30_000),
                timeoutMs: 30_000,
              },
            );
            const body = await candidateRegistrationResponseBody(response);
            const disposition = candidateRegistrationDisposition(body, audits, resultSha256);
            claimed = disposition.claimed;
            const candidate = body.candidate && typeof body.candidate === "object" && !Array.isArray(body.candidate)
              ? body.candidate as Record<string, unknown>
              : {};
            registered = {
              ...body,
              replayed: disposition.replayed,
              ...(typeof candidate.candidate_set_id === "string"
                ? { candidate_set_id: candidate.candidate_set_id }
                : {}),
            };
          } finally {
            if (audits && !claimed) await removeUnclaimedPair(audits, principal);
          }
        }
        const details = validated
          ? { ...publicValidationDetails(validated), ...(registered ?? {}) }
          : params;
        const content = validated
          ? JSON.stringify({ ...details, schema: "mathpilot.content-respond/v1" })
          : "responded";
        return {
          content: [{ type: "text", text: content }],
          details,
          terminate: true,
        };
      } finally {
        if (validated) {
          await Promise.all([validated.resultSealed.cleanup(), validated.receiptSealed.cleanup()]);
        }
      }
    },
  });
};
