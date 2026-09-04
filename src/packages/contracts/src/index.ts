/**
 * @mathpilot/contracts — 契约包入口（ADR-003）。
 * JSON Schema 位于 ../schemas（唯一契约源）；本文件导出 Provider TS 接口。
 */
export * from "./errors.js";
export * from "./http-problem.js";
export {
  MATH_DERIVATION_ARTIFACT_SCHEMA,
  MATH_DERIVATION_ARTIFACT_SCHEMA_URI,
} from "./science-v3-learning.js";
export type * from "./science-v3-learning.js";
export {
  LEARNING_ACTION_TOOL_PARAMETERS,
  parseBoundedLearningAction,
} from "./science-v3-learning-action.js";
export type { BoundedLearningAction } from "./science-v3-learning-action.js";
export {
  CANONICAL_MIRROR_MESSAGE_TYPE,
  CANONICAL_MIRROR_LINK_TYPE,
  MAX_CANONICAL_MIRROR_TRANSCRIPT_MESSAGES,
  CANONICAL_MIRROR_MESSAGE_SCHEMA,
  CANONICAL_MIRROR_DETAILS_SCHEMA,
  parseCanonicalMirrorMessage,
  parseCanonicalMirrorDetails,
} from "./pi-canonical-mirror.js";
export type {
  CanonicalMirrorMessage,
  CanonicalMirrorDetails,
} from "./pi-canonical-mirror.js";
export {
  INTERACTIVE_ADMISSION_RECEIPT_SCHEMA,
  INTERACTIVE_ATTEMPT_BINDING_SCHEMA,
  INTERACTIVE_WORKSPACE_PROJECTION_SCHEMA,
  INTERACTIVE_PREPARE_RESPONSE_SCHEMA,
  MAXIMUM_WORKSPACE_PROJECTION_BYTES,
  MAXIMUM_WORKSPACE_PROJECTION_FILES,
  MAXIMUM_WORKSPACE_PROJECTION_OBJECTS,
  MAXIMUM_INTERACTIVE_PREPARE_RESPONSE_BYTES,
  parseInteractiveAdmissionReceipt,
  parseInteractiveAttemptBinding,
  parseInteractiveWorkspaceProjection,
  parseInteractivePrepareResponse,
  interactiveReceiptBinding,
} from "./interactive-epoch.js";
export type {
  InteractiveAdmissionReceipt,
  InteractiveAttemptBinding,
  InteractiveWorkspaceProjection,
  InteractivePrepareResponse,
} from "./interactive-epoch.js";
export type * from "./providers/model.js";
export type * from "./providers/ocr.js";
export type * from "./providers/search.js";
export type * from "./providers/media.js";
export type * from "./providers/explanation.js";
export type * from "./providers/artifact.js";
export type * from "./providers/sandbox.js";
export type * from "./providers/auth.js";
