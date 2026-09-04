import { proxyActivities } from "@temporalio/workflow";

interface StorageGarbageCollectionActivities {
  sweepStorageGarbage(): Promise<void>;
}

const { sweepStorageGarbage } = proxyActivities<StorageGarbageCollectionActivities>({
  startToCloseTimeout: "2m",
  retry: {
    maximumAttempts: 10,
    initialInterval: "1s",
    backoffCoefficient: 2,
    maximumInterval: "30s",
  },
});

/** Durable owner for expiry and user-requested immutable object deletion. */
export async function storageGarbageCollectionWorkflow(): Promise<void> {
  await sweepStorageGarbage();
}
