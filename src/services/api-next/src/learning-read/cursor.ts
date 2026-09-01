import { createHmac, timingSafeEqual } from "node:crypto";
import { apiNextSecurityConfig } from "../security-config.ts";

const cursorPrefix = "mathpilot-cursor-v1:";

export function encodeCursor(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("cursor value must be a non-negative integer");
  return Buffer.from(`${cursorPrefix}${value}`, "utf8").toString("base64url");
}

export function decodeCursor(value: unknown): number {
  if (value === undefined || value === null || value === "") return 0;
  if (typeof value !== "string" || value.length > 256) throw new LearningReadError(400, "invalid_cursor", "游标无效");
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    if (!decoded.startsWith(cursorPrefix)) throw new Error("prefix");
    const number = Number(decoded.slice(cursorPrefix.length));
    if (!Number.isSafeInteger(number) || number < 0) throw new Error("number");
    return number;
  } catch {
    throw new LearningReadError(400, "invalid_cursor", "游标无效");
  }
}

export class LearningReadError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

export interface EvidenceReference {
  kind: "question-session" | "attempt" | "judgment" | "annotation" | "mastery" | "retention" | "error-pattern";
  id: string;
  studentId: string;
}

const evidenceSecret = apiNextSecurityConfig().evidenceSecret;

export function evidenceHandle(reference: EvidenceReference): string {
  const payload = Buffer.from(JSON.stringify({ v: 1, ...reference }), "utf8").toString("base64url");
  const signature = createHmac("sha256", evidenceSecret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function parseEvidenceHandle(value: string): EvidenceReference {
  if (!value || value.length > 1000) throw new LearningReadError(404, "evidence_not_found", "依据不存在或已失效");
  const [payload, supplied, extra] = value.split(".");
  if (!payload || !supplied || extra) throw new LearningReadError(404, "evidence_not_found", "依据不存在或已失效");
  const expected = createHmac("sha256", evidenceSecret).update(payload).digest();
  let actual: Buffer;
  try { actual = Buffer.from(supplied, "base64url"); } catch { throw new LearningReadError(404, "evidence_not_found", "依据不存在或已失效"); }
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new LearningReadError(404, "evidence_not_found", "依据不存在或已失效");
  }
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
    const kinds = new Set(["question-session", "attempt", "judgment", "annotation", "mastery", "retention", "error-pattern"]);
    if (parsed.v !== 1 || typeof parsed.kind !== "string" || !kinds.has(parsed.kind)
      || typeof parsed.id !== "string" || !parsed.id || typeof parsed.studentId !== "string"
      || !/^stu_[A-Za-z0-9]{8,}$/.test(parsed.studentId)) throw new Error("shape");
    return { kind: parsed.kind as EvidenceReference["kind"], id: parsed.id, studentId: parsed.studentId };
  } catch {
    throw new LearningReadError(404, "evidence_not_found", "依据不存在或已失效");
  }
}
