import type { InternalEdgeId, InternalServiceId } from "./topology.ts";

export type MathPilotEnvironment = "development" | "test" | "production";

export interface InternalActor {
  tenantId: string;
  userId: string;
  roles: readonly ("student" | "teacher")[];
}

export interface InternalServiceContext {
  edge: InternalEdgeId;
  caller: InternalServiceId;
  audience: InternalServiceId;
  actor: InternalActor;
  assertionId: string;
  issuedAt: number;
  expiresAt: number;
  keyId: string;
}

export type InternalIdentityEventCode =
  | "assertion_issued"
  | "assertion_verified"
  | "assertion_previous_key_verified"
  | "assertion_rejected"
  | "request_failed";

export interface InternalIdentityEvent {
  code: InternalIdentityEventCode;
  service: InternalServiceId;
  edge?: InternalEdgeId;
  keyId?: string;
  reason?: string;
}

export type InternalIdentityObserver = (event: InternalIdentityEvent) => void;

export interface InternalServiceReadiness {
  state: "ready";
  service: InternalServiceId;
  environment: MathPilotEnvironment;
  outgoing: ReadonlyArray<{ edge: InternalEdgeId; activeKeyId: string }>;
  incoming: ReadonlyArray<{ edge: InternalEdgeId; acceptedKeyIds: readonly string[] }>;
  replayProtection: "memory-single-replica";
}
