import { createHash } from "node:crypto";
import type { CommandCapability, LearningView, LearningViewKind } from "@mathpilot/contracts";

export interface ViewOptions<T extends object> {
  kind: LearningViewKind;
  resourceKind: string;
  resourceId: string;
  version: number;
  factsThrough?: Date | string | null | undefined;
  permissions?: string[];
  redactions?: string[];
  data: T;
  capabilities?: CommandCapability[];
  projectionStatus?: LearningView<T>["projection_status"];
  freshnessNote?: string;
}

export function learningView<T extends object>(options: ViewOptions<T>): LearningView<T> {
  const generatedAt = new Date().toISOString();
  return {
    schema: `mathpilot.learning-view/${options.kind}/v1`,
    view_kind: options.kind,
    resource: {
      kind: options.resourceKind,
      id: options.resourceId,
      version: Math.max(1, Math.trunc(options.version)),
    },
    generated_at: generatedAt,
    facts_through: options.factsThrough ? new Date(options.factsThrough).toISOString() : generatedAt,
    projection_status: options.projectionStatus ?? "ready",
    ...(options.freshnessNote ? { freshness_note: options.freshnessNote } : {}),
    permissions: options.permissions ?? [],
    ...(options.redactions?.length ? { redactions: options.redactions } : {}),
    data: options.data,
    command_capabilities: options.capabilities ?? [],
  };
}

export function viewEtag(view: LearningView): string {
  // generated_at changes on every read, while the remainder is the cached
  // representation. Hashing that representation keeps composite views fresh
  // when child resources change without advancing the parent resource version.
  const representation = { ...view, generated_at: undefined };
  const digest = createHash("sha256").update(JSON.stringify(representation)).digest("base64url");
  return `W/\"${digest}\"`;
}

export function capability(
  action: CommandCapability["action"],
  href: string,
  expectedVersion: number,
  disabledReason?: string,
): CommandCapability {
  return {
    action,
    href,
    method: "POST",
    expected_version: Math.max(0, Math.trunc(expectedVersion)),
    ...(disabledReason ? { disabled_reason: disabledReason } : {}),
  };
}
