export type MathPilotEnvironment = "development" | "test" | "production";

export interface ApiNextSecurityConfig {
  environment: MathPilotEnvironment;
  betterAuthSecret: string;
  evidenceSecret: string;
  defaultTenantId: string;
}

type EnvironmentSource = Readonly<Record<string, string | undefined>>;

const DEV_AUTH_SECRET = "mathpilot-dev-secret-change-me-at-least-32-characters";
const DEV_EVIDENCE_SECRET = "mathpilot-dev-evidence-secret-change-me-at-least-32-characters";
const KNOWN_DEVELOPMENT_SECRETS = new Set([DEV_AUTH_SECRET, DEV_EVIDENCE_SECRET]);
const MIN_SECRET_BYTES = 32;
const DEVELOPMENT_DEFAULT_TENANT = "tnt_dev00001";
const tenantIdPattern = /^tnt_[A-Za-z0-9]{8,}$/;

function environmentOf(source: EnvironmentSource): MathPilotEnvironment {
  const value = source.MATHPILOT_ENVIRONMENT?.trim() || "production";
  if (value !== "development" && value !== "test" && value !== "production") {
    throw new Error("MATHPILOT_ENVIRONMENT must be development, test, or production");
  }
  return value;
}

function requiredSecret(
  name: "BETTER_AUTH_SECRET" | "LEARNING_EVIDENCE_SECRET",
  configured: string | undefined,
  developmentDefault: string,
  environment: MathPilotEnvironment,
): string {
  const value = configured && configured.trim() ? configured : environment === "development" ? developmentDefault : "";
  if (!value) throw new Error(`${name} is required outside the explicit development profile`);
  if (Buffer.byteLength(value, "utf8") < MIN_SECRET_BYTES) {
    throw new Error(`${name} must contain at least ${MIN_SECRET_BYTES} bytes`);
  }
  if (environment !== "development" && KNOWN_DEVELOPMENT_SECRETS.has(value)) {
    throw new Error(`${name} cannot use a MathPilot development default outside development`);
  }
  return value;
}

export function loadApiNextSecurityConfig(source: EnvironmentSource = process.env): ApiNextSecurityConfig {
  const environment = environmentOf(source);
  const betterAuthSecret = requiredSecret("BETTER_AUTH_SECRET", source.BETTER_AUTH_SECRET, DEV_AUTH_SECRET, environment);
  const evidenceSecret = requiredSecret("LEARNING_EVIDENCE_SECRET", source.LEARNING_EVIDENCE_SECRET, DEV_EVIDENCE_SECRET, environment);
  if (betterAuthSecret === evidenceSecret) {
    throw new Error("LEARNING_EVIDENCE_SECRET must be independent from BETTER_AUTH_SECRET");
  }
  const defaultTenantId = source.DEFAULT_TENANT_ID?.trim()
    || (environment === "development" ? DEVELOPMENT_DEFAULT_TENANT : "");
  if (!defaultTenantId) throw new Error("DEFAULT_TENANT_ID is required outside the explicit development profile");
  if (!tenantIdPattern.test(defaultTenantId)) throw new Error("DEFAULT_TENANT_ID must be a valid tenant ID");
  return Object.freeze({ environment, betterAuthSecret, evidenceSecret, defaultTenantId });
}

let runtimeConfig: ApiNextSecurityConfig | undefined;

export function apiNextSecurityConfig(): ApiNextSecurityConfig {
  runtimeConfig ??= loadApiNextSecurityConfig();
  return runtimeConfig;
}
