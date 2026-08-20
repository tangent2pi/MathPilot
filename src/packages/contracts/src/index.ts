/**
 * @mathpilot/contracts — 契约包入口（ADR-003）。
 * JSON Schema 位于 ../schemas（唯一契约源）；本文件导出 Provider TS 接口。
 */
export * from "./errors.js";
export type * from "./providers/model.js";
export type * from "./providers/ocr.js";
export type * from "./providers/search.js";
export type * from "./providers/media.js";
export type * from "./providers/explanation.js";
export type * from "./providers/artifact.js";
export type * from "./providers/sandbox.js";
export type * from "./providers/auth.js";
