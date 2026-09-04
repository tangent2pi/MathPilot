import type { CommandCapability, LearningView, LearningViewKind } from "@mathpilot/contracts";
import { createHash } from "node:crypto";

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
  // 内容感知 ETag：行版本前进之外，任何 data / 事实水位变化（如删除非最大
  // version 的对话、归档低版本行等）都会改变摘要 → 条件请求返回 200 而非 304，
  // 避免浏览器用 HTTP 缓存喂给前端陈旧列表（曾致"删除对话后仍显示"）。
  // generated_at 等瞬态字段不参与摘要，保证无变化视图仍可 304。
  const digest = createHash("sha1")
    .update(view.resource.kind)
    .update("\u0000")
    .update(view.resource.id)
    .update(`\u0000v${view.resource.version}`)
    .update(`\u0000f${view.facts_through ?? ""}`)
    .update(`\u0000d${JSON.stringify(view.data)}`)
    .digest("hex")
    .slice(0, 16);
  return `W/\"${view.resource.kind}:${view.resource.id}:${digest}\"`;
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
