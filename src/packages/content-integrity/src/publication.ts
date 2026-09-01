import {
  immutableObjectDescriptorSchema,
  storagePublicationRequestSchema,
  storageUploadDescriptorSchema,
  type ImmutableObjectDescriptor,
  type StoragePublicationRequest,
  type StorageUploadDescriptor,
} from "./policy.ts";

export type { StoragePublicationRequest } from "./policy.ts";

export interface StoragePublicationExpectedBytes {
  readonly sha256: string;
  readonly byteSize: number;
  readonly mimeType: string;
}

export interface StoragePublicationAdapter {
  initialize(request: StoragePublicationRequest, signal: AbortSignal): Promise<unknown>;
  upload(descriptor: StorageUploadDescriptor, signal: AbortSignal): Promise<void>;
  complete(objectId: string, signal: AbortSignal): Promise<unknown>;
  removeUnclaimed(objectId: string, signal: AbortSignal): Promise<void>;
}

const boundedSignal = (parent: AbortSignal | undefined, milliseconds: number): AbortSignal =>
  parent
    ? AbortSignal.any([parent, AbortSignal.timeout(milliseconds)])
    : AbortSignal.timeout(milliseconds);

/**
 * The one control-plane state machine for browser and host object publication.
 * Data-plane transports remain thin adapters (Uppy in the browser, FormData on
 * the host), while init/complete parsing, deadlines, cancellation, cleanup and
 * sealed-byte equality stay identical for every producer.
 */
export async function publishStorageObject(input: {
  readonly request: StoragePublicationRequest;
  readonly adapter: StoragePublicationAdapter;
  readonly expectedStored?: StoragePublicationExpectedBytes;
  readonly signal?: AbortSignal;
}): Promise<ImmutableObjectDescriptor> {
  const request = storagePublicationRequestSchema.parse(input.request);
  const initialized = storageUploadDescriptorSchema.parse(await input.adapter.initialize(
    request,
    boundedSignal(input.signal, 30_000),
  ));

  try {
    await input.adapter.upload(initialized, boundedSignal(input.signal, 5 * 60_000));
    const completed = immutableObjectDescriptorSchema.parse(await input.adapter.complete(
      initialized.object_id,
      boundedSignal(input.signal, 5 * 60_000),
    ));
    if (input.expectedStored && (
      completed.sha256 !== input.expectedStored.sha256
      || completed.byte_size !== input.expectedStored.byteSize
      || completed.mime_type !== input.expectedStored.mimeType
    )) {
      throw new Error("published object differs from the sealed bytes");
    }
    return completed;
  } catch (error) {
    await input.adapter.removeUnclaimed(
      initialized.object_id,
      AbortSignal.timeout(10_000),
    ).catch(() => undefined);
    throw error;
  }
}
