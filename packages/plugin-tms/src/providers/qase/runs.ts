/**
 * Run lifecycle — the half of result sync the reporter cannot do.
 *
 * The reporter creates a run when it starts and completes it when it ends, which is right for a single
 * process and wrong for every sharded CI job: four shards would open four runs and split one suite's
 * results across them. So CI creates the run **once**, hands every shard the id through
 * `QASE_TESTOPS_RUN_ID`, and completes it after the last shard exits. That is what these two functions
 * are for, and why `tms run complete` is a separate command rather than a reporter hook.
 *
 * @example
 * const run = await createRun(client, { title: 'main · a1b2c3d · staging' });
 * // …shards run with QASE_TESTOPS_RUN_ID=run.id…
 * await completeRun(client, run.id);
 */
import type { TmsRunInput, TmsRunRef } from '../../provider.js';
import type { QaseClient } from './client.js';

/** Qase's `IdResponse`. */
interface IdResult {
  id: number;
}

/** Where a human opens the run. Derived, because the API does not return a URL. */
export function runUrl(project: string, id: string): string {
  return `https://app.qase.io/run/${project}/dashboard/${id}`;
}

export async function createRun(client: QaseClient, input: TmsRunInput): Promise<TmsRunRef> {
  const result = await client.post<IdResult>(`/run/${client.project}`, {
    title: input.title,
    ...(input.description === undefined ? {} : { description: input.description }),
    ...(input.environment === undefined || input.environment === ''
      ? {}
      : { environment_slug: input.environment }),
    ...(input.milestoneId === undefined ? {} : { milestone_id: input.milestoneId }),
    ...(input.planId === undefined ? {} : { plan_id: input.planId }),
    ...(input.tags === undefined || input.tags.length === 0 ? {} : { tags: input.tags }),
    // Without this the run is a manual one, and Qase's own automation views filter it out.
    is_autotest: true,
  });
  const id = String(result.id);
  return { id, url: runUrl(client.project, id) };
}

export async function completeRun(client: QaseClient, runId: string): Promise<void> {
  await client.post<unknown>(`/run/${client.project}/${runId}/complete`, undefined);
}
