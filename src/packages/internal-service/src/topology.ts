export const INTERNAL_SERVICE_IDS = [
  "api-next",
  "content-next",
  "learning-next",
  "pi-chat-runtime",
  "storage-next",
] as const;

export type InternalServiceId = typeof INTERNAL_SERVICE_IDS[number];

export interface InternalEdgeDefinition {
  id: InternalEdgeId;
  caller: InternalServiceId;
  audience: InternalServiceId;
  keyringEnv: string;
  targetUrlEnv: string;
}

export const INTERNAL_EDGES = {
  "api-to-content": {
    id: "api-to-content",
    caller: "api-next",
    audience: "content-next",
    keyringEnv: "MATHPILOT_INTERNAL_API_TO_CONTENT_KEYRING",
    targetUrlEnv: "MATHPILOT_INTERNAL_CONTENT_URL",
  },
  "api-to-storage": {
    id: "api-to-storage",
    caller: "api-next",
    audience: "storage-next",
    keyringEnv: "MATHPILOT_INTERNAL_API_TO_STORAGE_KEYRING",
    targetUrlEnv: "MATHPILOT_INTERNAL_STORAGE_URL",
  },
  "api-to-pi": {
    id: "api-to-pi",
    caller: "api-next",
    audience: "pi-chat-runtime",
    keyringEnv: "MATHPILOT_INTERNAL_API_TO_PI_KEYRING",
    targetUrlEnv: "MATHPILOT_INTERNAL_PI_URL",
  },
  "content-to-pi": {
    id: "content-to-pi",
    caller: "content-next",
    audience: "pi-chat-runtime",
    keyringEnv: "MATHPILOT_INTERNAL_CONTENT_TO_PI_KEYRING",
    targetUrlEnv: "MATHPILOT_INTERNAL_PI_URL",
  },
  "pi-to-content": {
    id: "pi-to-content",
    caller: "pi-chat-runtime",
    audience: "content-next",
    keyringEnv: "MATHPILOT_INTERNAL_PI_TO_CONTENT_KEYRING",
    targetUrlEnv: "MATHPILOT_INTERNAL_CONTENT_URL",
  },
  "pi-to-storage": {
    id: "pi-to-storage",
    caller: "pi-chat-runtime",
    audience: "storage-next",
    keyringEnv: "MATHPILOT_INTERNAL_PI_TO_STORAGE_KEYRING",
    targetUrlEnv: "MATHPILOT_INTERNAL_STORAGE_URL",
  },
  "pi-to-learning": {
    id: "pi-to-learning",
    caller: "pi-chat-runtime",
    audience: "learning-next",
    keyringEnv: "MATHPILOT_INTERNAL_PI_TO_LEARNING_KEYRING",
    targetUrlEnv: "MATHPILOT_INTERNAL_LEARNING_URL",
  },
  "learning-to-storage": {
    id: "learning-to-storage",
    caller: "learning-next",
    audience: "storage-next",
    keyringEnv: "MATHPILOT_INTERNAL_LEARNING_TO_STORAGE_KEYRING",
    targetUrlEnv: "MATHPILOT_INTERNAL_STORAGE_URL",
  },
} as const satisfies Record<string, Omit<InternalEdgeDefinition, "id"> & { id: string }>;

export type InternalEdgeId = keyof typeof INTERNAL_EDGES;

export const internalEdgesForService = (service: InternalServiceId): readonly InternalEdgeDefinition[] =>
  Object.values(INTERNAL_EDGES).filter((edge) => edge.caller === service || edge.audience === service) as InternalEdgeDefinition[];

export const internalEdge = (id: InternalEdgeId): InternalEdgeDefinition => INTERNAL_EDGES[id] as InternalEdgeDefinition;

export const serviceIssuer = (service: InternalServiceId): string => `urn:mathpilot:service:${service}`;
