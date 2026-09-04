import {
  ScheduleAlreadyRunning,
  type Client,
  type ScheduleOptionsAction,
  type ScheduleUpdateOptions,
} from "@temporalio/client";

type ScheduleClient = Pick<Client["schedule"], "create" | "getHandle">;

/**
 * Reconcile one owned schedule without duplicating create-or-update handling.
 * An operator pause/remaining-action limit survives service restarts and
 * definition changes; new schedules use the state declared by their owner.
 */
export async function reconcileTemporalSchedule<Action extends ScheduleOptionsAction>(
  schedules: ScheduleClient,
  scheduleId: string,
  definition: ScheduleUpdateOptions<Action>,
): Promise<void> {
  try {
    await schedules.create({ scheduleId, ...definition });
  } catch (error) {
    if (!(error instanceof ScheduleAlreadyRunning)) throw error;
    await schedules.getHandle(scheduleId).update((previous) => ({
      ...definition,
      state: {
        ...definition.state,
        paused: previous.state.paused,
        note: previous.state.note,
        remainingActions: previous.state.remainingActions,
      },
    }));
  }
}
