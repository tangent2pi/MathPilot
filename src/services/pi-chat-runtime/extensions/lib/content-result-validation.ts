import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { CONTENT_POLICIES } from "@mathpilot/content-integrity";
import { sealBoundedHostFile, type SealedContent } from "@mathpilot/content-integrity/node";

type JsonObject = Record<string, unknown>;

export interface ValidatedContentResult {
  kind: "ktq" | "er";
  schema: string;
  resultFile: string;
  validationFile: string;
  sha256: string;
  itemCount: number;
  result: JsonObject;
  receipt: JsonObject;
  resultSealed: SealedContent;
  receiptSealed: SealedContent;
}

const FORMATS = new Set(["single_choice", "multiple_choice", "fill_blank", "true_false", "open_solution"]);
const TARGET_ROLES = new Set(["primary", "secondary", "prerequisite"]);
const isObject = (value: unknown): value is JsonObject => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

const relativeOutputPath = (cwd: string, value: string): string => {
  if (!value || path.isAbsolute(value)) throw new Error("result paths must be relative");
  const normalized = path.posix.normalize(value.replaceAll("\\", "/"));
  if (!normalized.startsWith("output/") || normalized.includes("../") || normalized.endsWith("/")) throw new Error("result paths must stay below output/");
  const absolute = path.resolve(cwd, normalized);
  const root = path.resolve(cwd, "output");
  if (!absolute.startsWith(`${root}${path.sep}`)) throw new Error("result path escapes output/");
  return normalized;
};

const sealJsonObject = async (
  cwd: string,
  relative: string,
): Promise<{ value: JsonObject; sealed: SealedContent }> => {
  const file = path.resolve(cwd, relative);
  const sealed = await sealBoundedHostFile({
    root: path.resolve(cwd, "output"),
    file,
    policy: CONTENT_POLICIES.candidate,
    declaredMimeType: "application/json",
  });
  try {
    const value = JSON.parse(await readFile(sealed.storedPath, "utf8")) as unknown;
    if (!isObject(value)) throw new Error("result must be a JSON object");
    return { value, sealed };
  } catch (error) {
    await sealed.cleanup();
    throw error;
  }
};

/** Evidence and image references must resolve to host-provided input files.
 * Allowing an arbitrary workspace path would let a model write a file under
 * output/ and cite its own fabricated evidence. */
const inputFile = async (cwd: string, reference: string): Promise<boolean> => {
  if (!reference || path.isAbsolute(reference)) return false;
  const normalized = path.posix.normalize(reference.replaceAll("\\", "/"));
  if (normalized === "." || normalized.startsWith("../") || normalized.includes("/../") || normalized.includes("\u0000")) return false;
  const root = await realpath(path.resolve(cwd, "input")).catch(() => undefined);
  if (!root) return false;
  const candidates = normalized.startsWith("input/")
    ? [path.resolve(cwd, normalized)]
    : [path.resolve(cwd, "input", normalized)];
  for (const candidate of candidates) {
    const resolved = await realpath(candidate).catch(() => undefined);
    if (!resolved || !resolved.startsWith(`${root}${path.sep}`)) continue;
    if ((await stat(resolved).catch(() => undefined))?.isFile()) return true;
  }
  return false;
};

const validateKtq = async (cwd: string, value: JsonObject): Promise<number> => {
  if (value.schema !== "mathpilot.ktq-result/v1" || !Array.isArray(value.questions) || value.questions.length === 0) throw new Error("invalid KTQ result schema");
  const seen = new Set<string>();
  for (const [index, question] of value.questions.entries()) {
    if (!isObject(question) || !nonEmpty(question.stem_markdown)) throw new Error(`KTQ question ${index} has no stem`);
    if (typeof question.stem_format !== "string" || !FORMATS.has(question.stem_format) || !Array.isArray(question.options) || !Array.isArray(question.image_refs)) throw new Error(`KTQ question ${index} has invalid shape`);
    if ((question.stem_format === "single_choice" || question.stem_format === "multiple_choice") && question.options.length < 2) throw new Error(`KTQ question ${index} needs at least two options`);
    if (question.options.some((entry) => !isObject(entry) || !nonEmpty(entry.key) || !nonEmpty(entry.text_markdown))) throw new Error(`KTQ question ${index} has invalid options`);
    if (question.image_refs.some((entry) => typeof entry !== "string" || !entry.trim())) throw new Error(`KTQ question ${index} has invalid image references`);
    for (const reference of question.image_refs as unknown[]) {
      if (!(await inputFile(cwd, reference as string))) throw new Error(`KTQ question ${index} references a missing input image`);
    }
    const source = question.source;
    if (!isObject(source) || !nonEmpty(source.path) || !Number.isSafeInteger(source.page) || Number(source.page) < 1 || !(await inputFile(cwd, source.path))) throw new Error(`KTQ question ${index} has invalid source evidence`);
    if (source.bbox !== null && source.bbox !== undefined && (!Array.isArray(source.bbox) || source.bbox.length !== 4 || source.bbox.some((part) => typeof part !== "number" || !Number.isFinite(part)))) throw new Error(`KTQ question ${index} has invalid source bbox`);
    const components = question.knowledge_components;
    if (!Array.isArray(components) || components.length === 0 || components.some((entry) => !isObject(entry) || !/^K_[A-Za-z0-9_.:-]+$/.test(String(entry.id)) || !nonEmpty(entry.name))) throw new Error(`KTQ question ${index} has invalid K entries`);
    const type = question.question_type;
    if (!isObject(type) || !/^T_[A-Za-z0-9_.:-]+$/.test(String(type.id)) || !nonEmpty(type.name)) throw new Error(`KTQ question ${index} has invalid T entry`);
    if (typeof question.difficulty !== "number" || !Number.isFinite(question.difficulty) || question.difficulty < 0 || question.difficulty > 1) throw new Error(`KTQ question ${index} has invalid difficulty`);
    const declared = new Set([...components.map((entry) => String((entry as JsonObject).id)), String(type.id)]);
    if (!Array.isArray(question.measurement_targets) || question.measurement_targets.length === 0 || question.measurement_targets.some((entry) => !isObject(entry) || !nonEmpty(entry.dim) || !TARGET_ROLES.has(String(entry.role)) || !nonEmpty(entry.evidence_rule) || !declared.has(String(entry.dim)))) throw new Error(`KTQ question ${index} has invalid measurement targets`);
    if (!Array.isArray(question.rubric) || question.rubric.length === 0 || question.rubric.some((entry) => !isObject(entry) || !nonEmpty(entry.id) || !nonEmpty(entry.description))) throw new Error(`KTQ question ${index} has invalid rubric`);
    if (!isObject(question.answer) || !["new", "duplicate", "merge"].includes(String(question.dedup_action))) throw new Error(`KTQ question ${index} has invalid answer/dedup action`);
    if (["duplicate", "merge"].includes(String(question.dedup_action)) && !nonEmpty(question.duplicate_of)) throw new Error(`KTQ question ${index} needs duplicate_of`);
    const normalized = question.stem_markdown.replace(/[\s，。；：！？、,.!?;:]/g, "").toLocaleLowerCase();
    if (seen.has(normalized) && question.dedup_action === "new") throw new Error(`KTQ question ${index} duplicates another new question`);
    seen.add(normalized);
  }
  return value.questions.length;
};

const validateEr = (value: JsonObject, frozenDimensions: Set<string>): number => {
  if (value.schema !== "mathpilot.er-result/v1" || !Array.isArray(value.error_causes) || !Array.isArray(value.diagnosis_rules)) throw new Error("invalid ER result schema");
  const ids = new Set<string>();
  const reusedErrors = new Set<string>();
  const reusedErrorEntries = value.reused_error_causes === undefined ? [] : value.reused_error_causes;
  if (!Array.isArray(reusedErrorEntries)) throw new Error("reused_error_causes must be an array");
  for (const entry of reusedErrorEntries) {
    const id = isObject(entry) ? entry.id : entry;
    if (!nonEmpty(id) || !/^E_[A-Za-z0-9_.:-]+$/.test(id)) throw new Error("invalid reused error cause");
    if (reusedErrors.has(id)) throw new Error(`duplicate reused error cause ${id}`);
    reusedErrors.add(id);
  }
  const reusedRuleEntries = value.reused_rules === undefined ? [] : value.reused_rules;
  if (!Array.isArray(reusedRuleEntries)) throw new Error("reused_rules must be an array");
  const reusedRules = new Set<string>();
  for (const entry of reusedRuleEntries) {
    const id = isObject(entry) ? entry.id : entry;
    if (!nonEmpty(id) || !/^R_[A-Za-z0-9_.:-]+$/.test(id)) throw new Error("invalid reused diagnosis rule");
    if (reusedRules.has(id)) throw new Error(`duplicate reused diagnosis rule ${id}`);
    reusedRules.add(id);
  }
  for (const [index, entry] of value.error_causes.entries()) {
    if (!isObject(entry) || !/^E_[A-Za-z0-9_.:-]+$/.test(String(entry.id)) || !nonEmpty(entry.name) || !nonEmpty(entry.description)) throw new Error(`ER error cause ${index} is invalid`);
    if (ids.has(String(entry.id))) throw new Error(`duplicate ER id ${entry.id}`);
    ids.add(String(entry.id));
  }
  for (const [index, entry] of value.diagnosis_rules.entries()) {
    if (!isObject(entry) || !/^R_[A-Za-z0-9_.:-]+$/.test(String(entry.id)) || !nonEmpty(entry.trigger) || !nonEmpty(entry.probe) || !Array.isArray(entry.candidate_error_causes) || entry.candidate_error_causes.length === 0 || entry.candidate_error_causes.some((id) => !nonEmpty(id) || (!ids.has(id) && !reusedErrors.has(id))) || !Array.isArray(entry.dimension_ids) || entry.dimension_ids.length === 0 || entry.dimension_ids.some((id) => !nonEmpty(id) || (frozenDimensions.size > 0 && !frozenDimensions.has(id))) || !Array.isArray(entry.citations) || entry.citations.some((citation) => !isObject(citation) || !nonEmpty(citation.url) || !/^https?:\/\//i.test(citation.url) || !nonEmpty(citation.title))) throw new Error(`ER diagnosis rule ${index} is invalid`);
    if (ids.has(String(entry.id))) throw new Error(`duplicate ER id ${entry.id}`);
    ids.add(String(entry.id));
  }
  return value.error_causes.length + value.diagnosis_rules.length;
};

export async function validateContentRespond(cwd: string, params: { result_file?: unknown; validation_file?: unknown }): Promise<ValidatedContentResult> {
  if (typeof params.result_file !== "string" || typeof params.validation_file !== "string") throw new Error("content respond requires result_file and validation_file");
  const resultFile = relativeOutputPath(cwd, params.result_file);
  const validationFile = relativeOutputPath(cwd, params.validation_file);
  if (resultFile === validationFile) throw new Error("result and validation files must differ");
  const resultCapture = await sealJsonObject(cwd, resultFile);
  let receiptCapture: Awaited<ReturnType<typeof sealJsonObject>>;
  try {
    receiptCapture = await sealJsonObject(cwd, validationFile);
  } catch (error) {
    await resultCapture.sealed.cleanup();
    throw error;
  }
  let handedOff = false;
  try {
    const value = resultCapture.value;
    const receipt = receiptCapture.value;
    const expectedSkill = value.schema === "mathpilot.ktq-result/v1"
      ? "ktq-extraction"
      : value.schema === "mathpilot.er-result/v1"
        ? "er-research"
        : undefined;
    if (
      !expectedSkill
      || receipt.schema !== "mathpilot.validation-receipt/v1"
      || receipt.valid !== true
      || receipt.result_file !== resultFile
      || receipt.skill !== expectedSkill
      || !nonEmpty(receipt.sha256)
    ) {
      throw new Error("validation receipt does not match result file");
    }
    const sha256 = resultCapture.sealed.source.sha256;
    if (receipt.sha256 !== sha256) throw new Error("validation receipt hash mismatch");
    let itemCount: number;
    if (expectedSkill === "ktq-extraction") {
      itemCount = await validateKtq(cwd, value);
    } else {
      const frozenFile = path.resolve(cwd, "input/frozen/ktq.json");
      const frozen = JSON.parse(await readFile(frozenFile, "utf8")) as unknown;
      if (!isObject(frozen) || !Array.isArray(frozen.questions)) {
        throw new Error("ER respond requires input/frozen/ktq.json");
      }
      const frozenDimensions = new Set<string>();
      for (const question of frozen.questions) {
        if (!isObject(question)) continue;
        if (Array.isArray(question.measurement_dims)) {
          for (const dimension of question.measurement_dims) {
            if (nonEmpty(dimension)) frozenDimensions.add(dimension);
          }
        }
        if (Array.isArray(question.measurement_targets)) {
          for (const target of question.measurement_targets) {
            if (isObject(target) && nonEmpty(target.dim)) frozenDimensions.add(target.dim);
          }
        }
      }
      if (frozenDimensions.size === 0) throw new Error("frozen KTQ has no measurement dimensions");
      itemCount = validateEr(value, frozenDimensions);
    }
    if (
      expectedSkill === "ktq-extraction"
      && receipt.question_count !== undefined
      && receipt.question_count !== itemCount
    ) {
      throw new Error("validation receipt question count mismatch");
    }
    if (expectedSkill === "er-research") {
      const errorCount = Array.isArray(value.error_causes) ? value.error_causes.length : 0;
      const ruleCount = Array.isArray(value.diagnosis_rules) ? value.diagnosis_rules.length : 0;
      if (receipt.error_cause_count !== undefined && receipt.error_cause_count !== errorCount) {
        throw new Error("validation receipt error-cause count mismatch");
      }
      if (receipt.rule_count !== undefined && receipt.rule_count !== ruleCount) {
        throw new Error("validation receipt rule count mismatch");
      }
    }
    const validated: ValidatedContentResult = {
      kind: expectedSkill === "ktq-extraction" ? "ktq" : "er",
      schema: String(value.schema),
      resultFile,
      validationFile,
      sha256,
      itemCount,
      result: value,
      receipt,
      resultSealed: resultCapture.sealed,
      receiptSealed: receiptCapture.sealed,
    };
    handedOff = true;
    return validated;
  } finally {
    if (!handedOff) {
      await Promise.all([resultCapture.sealed.cleanup(), receiptCapture.sealed.cleanup()]);
    }
  }
}
