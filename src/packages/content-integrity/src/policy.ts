import { z } from "zod";

export const STORAGE_OBJECT_REFERENCE_PATTERN = /^storage-object:(obj_[A-Za-z0-9]{8,})$/;

export const storageObjectPurposeSchema = z.enum(["source", "candidate", "package", "thread", "avatar", "derived"]);
export type StorageObjectPurpose = z.infer<typeof storageObjectPurposeSchema>;
export const uploadPurposeSchema = z.enum(["thread", "avatar", "candidate"]);
export type UploadPurpose = z.infer<typeof uploadPurposeSchema>;

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
export const storageObjectIdSchema = z.string().regex(/^obj_[A-Za-z0-9]{8,}$/);
export const storageObjectReferenceSchema = z.string().regex(STORAGE_OBJECT_REFERENCE_PATTERN);
const mimeTypeSchema = z.string().min(3).max(160).regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/);

const immutableObjectDescriptorShape = {
  object_id: storageObjectIdSchema,
  object_ref: storageObjectReferenceSchema,
  version_id: z.string().min(1).max(1024),
  sha256: sha256Schema,
  byte_size: z.number().int().positive(),
  mime_type: mimeTypeSchema,
  original_name: z.string().min(1).max(240),
  source: z.object({
    version_id: z.string().min(1).max(1024),
    sha256: sha256Schema,
    byte_size: z.number().int().positive(),
    mime_type: mimeTypeSchema,
  }).strict(),
  expires_at: z.string().datetime({ offset: true }).nullable(),
} as const;

export const immutableObjectDescriptorSchema = z.object(immutableObjectDescriptorShape).strict().superRefine((value, context) => {
  const match = STORAGE_OBJECT_REFERENCE_PATTERN.exec(value.object_ref);
  if (match?.[1] !== value.object_id) {
    context.addIssue({ code: "custom", path: ["object_ref"], message: "object_ref does not match object_id" });
  }
});

export type ImmutableObjectDescriptor = z.infer<typeof immutableObjectDescriptorSchema>;

export const resolvedObjectDescriptorSchema = z.object({
  ...immutableObjectDescriptorShape,
  download: z.object({
    url: z.string().url(),
    expires_at: z.string().datetime({ offset: true }),
  }).strict(),
}).strict().superRefine((value, context) => {
  const match = STORAGE_OBJECT_REFERENCE_PATTERN.exec(value.object_ref);
  if (match?.[1] !== value.object_id) {
    context.addIssue({ code: "custom", path: ["object_ref"], message: "object_ref does not match object_id" });
  }
});

export type ResolvedObjectDescriptor = z.infer<typeof resolvedObjectDescriptorSchema>;

export const storageObjectResolveRequestSchema = z.object({
  object_refs: z.array(storageObjectReferenceSchema).min(1).max(64),
}).strict().superRefine((value, context) => {
  if (new Set(value.object_refs).size !== value.object_refs.length) {
    context.addIssue({ code: "custom", path: ["object_refs"], message: "object_refs must be unique" });
  }
});

export const storageObjectResolveResponseSchema = z.object({
  objects: z.array(resolvedObjectDescriptorSchema).max(64),
}).strict();

export const storageUploadDescriptorSchema = z.object({
  object_id: storageObjectIdSchema,
  expires_at: z.string().datetime({ offset: true }),
  upload: z.object({
    method: z.literal("POST"),
    url: z.string().url(),
    fields: z.record(z.string(), z.string()),
  }).strict(),
}).strict();

export type StorageUploadDescriptor = z.infer<typeof storageUploadDescriptorSchema>;

export interface ImageNormalizationPolicy {
  readonly maximumPixels: number;
  readonly maximumChannels: number;
  readonly maximumDimension: number;
  readonly resizeWithin?: number;
  readonly webpQuality: number;
}

export interface ContentPolicy {
  readonly purpose: UploadPurpose;
  readonly maximumSourceBytes: number;
  readonly maximumStoredBytes: number;
  readonly allowedMimeTypes: readonly string[];
  readonly image?: ImageNormalizationPolicy;
  readonly canonicalJson?: boolean;
}

const MiB = 1024 * 1024;
export const MAXIMUM_THREAD_OBJECT_BYTES = 48 * MiB;

export const CONTENT_POLICIES = Object.freeze({
  thread: Object.freeze({
    purpose: "thread",
    maximumSourceBytes: MAXIMUM_THREAD_OBJECT_BYTES,
    maximumStoredBytes: MAXIMUM_THREAD_OBJECT_BYTES,
    allowedMimeTypes: Object.freeze([
      "image/jpeg", "image/png", "image/webp", "image/gif", "image/bmp",
      "application/json",
      "text/plain", "text/markdown", "text/csv",
    ]),
    image: Object.freeze({
      maximumPixels: 40_000_000,
      maximumChannels: 4,
      maximumDimension: 12_000,
      webpQuality: 90,
    }),
  }),
  avatar: Object.freeze({
    purpose: "avatar",
    maximumSourceBytes: 1_572_864,
    maximumStoredBytes: 768 * 1024,
    allowedMimeTypes: Object.freeze(["image/jpeg", "image/png", "image/webp"]),
    image: Object.freeze({
      maximumPixels: 16_000_000,
      maximumChannels: 4,
      maximumDimension: 8_192,
      resizeWithin: 512,
      webpQuality: 86,
    }),
  }),
  candidate: Object.freeze({
    purpose: "candidate",
    maximumSourceBytes: 4 * MiB,
    maximumStoredBytes: 4 * MiB,
    allowedMimeTypes: Object.freeze(["application/json"]),
    canonicalJson: true,
  }),
} satisfies Record<UploadPurpose, ContentPolicy>);

export const contentPolicy = (purpose: UploadPurpose): ContentPolicy => CONTENT_POLICIES[purpose];

export const parseObjectReference = (value: string): string | undefined =>
  STORAGE_OBJECT_REFERENCE_PATTERN.exec(value)?.[1];

export const canonicalObjectReference = (objectId: string): string => {
  if (!storageObjectIdSchema.safeParse(objectId).success) throw new Error("invalid storage object ID");
  return `storage-object:${objectId}`;
};
