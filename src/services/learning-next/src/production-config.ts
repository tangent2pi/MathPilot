import type { MathPilotEnvironment } from "@mathpilot/internal-service";

type EnvironmentSource = Readonly<Record<string, string | undefined>>;

const tenantIdPattern = /^tnt_[A-Za-z0-9]{8,}$/;

export function loadLearningTenantIds(
  environment: MathPilotEnvironment,
  source: EnvironmentSource = process.env,
): readonly string[] {
  const configured = source.LEARNING_NEXT_TENANT_IDS?.trim()
    || source.DEFAULT_TENANT_ID?.trim()
    || (environment === "development" ? "tnt_dev00001" : "");
  if (!configured) {
    throw new Error("LEARNING_NEXT_TENANT_IDS or DEFAULT_TENANT_ID is required outside development");
  }
  const tenantIds = [...new Set(configured.split(",").map((value) => value.trim()).filter(Boolean))];
  if (!tenantIds.length || tenantIds.some((value) => !tenantIdPattern.test(value))) {
    throw new Error("LEARNING_NEXT_TENANT_IDS must contain valid tenant IDs");
  }
  return Object.freeze(tenantIds);
}
