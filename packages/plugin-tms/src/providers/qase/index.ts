/**
 * The Qase provider — the first (and so far only) implementation of {@link TmsProvider}.
 *
 * Assembly only: the client, the run calls and the reporter each live in their own file, and this one
 * wires them to the interface. Keeping it thin is what makes the second provider a sibling directory
 * rather than a refactor.
 *
 * @example
 * const provider = createQaseProvider(readConfig());
 * const probe = await provider.probe();
 */
import type { Reporter } from '@playwright/test/reporter';

import type { TmsConfig } from '../../config.js';
import type { TmsProbe, TmsProvider, TmsRunInput, TmsRunRef } from '../../provider.js';
import { QaseClient, type QaseClientOptions } from './client.js';
import { missingQaseConfig, readQaseConfig, type QaseConfig } from './config.js';
import { createQaseReporter } from './reporter.js';
import { completeRun, createRun } from './runs.js';

interface ProjectResult {
  title?: string;
  code?: string;
}

export function createQaseProvider(
  config: TmsConfig,
  qase: QaseConfig = readQaseConfig(),
  clientOptions: QaseClientOptions = {},
): TmsProvider {
  const client = new QaseClient(qase, clientOptions);

  return {
    id: 'qase',

    /**
     * Configuration first, then the network — in that order, because "unauthorised" is a confusing way
     * to learn that the token was never set. Never throws: `tms doctor` prints every check, and a
     * thrown error would hide the ones after it.
     */
    async probe(): Promise<TmsProbe> {
      const missing = missingQaseConfig(qase);
      const checks: TmsProbe['checks'] = [
        {
          name: 'configuration',
          ok: missing.length === 0,
          detail:
            missing.length === 0 ? `project ${qase.project}` : `missing: ${missing.join(', ')}`,
        },
      ];
      if (missing.length > 0) {
        return { ok: false, checks };
      }

      try {
        const project = await client.get<ProjectResult>(`/project/${qase.project}`);
        checks.push({
          name: 'project',
          ok: true,
          detail: `${project.title ?? qase.project} reachable at ${qase.baseUrl}`,
        });
      } catch (error) {
        checks.push({
          name: 'project',
          ok: false,
          detail: error instanceof Error ? error.message : String(error),
        });
      }

      return { ok: checks.every(check => check.ok), checks };
    },

    createRun(input: TmsRunInput): Promise<TmsRunRef> {
      return createRun(client, input);
    },

    completeRun(runId: string): Promise<void> {
      return completeRun(client, runId);
    },

    /**
     * Throws on missing configuration rather than degrading to a no-op. `TMS_MODE=testops` is an
     * explicit instruction to publish; honouring it silently-not-at-all would leave a CI job green with
     * an empty run in Qase, which is the failure nobody catches until the audit.
     */
    createReporter(): Reporter {
      const missing = missingQaseConfig(qase);
      if (missing.length > 0) {
        throw new Error(
          `TMS_MODE=testops but ${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} not set. ` +
            'Set them in env/environments.json (or export them) — or unset TMS_MODE to run without publishing.',
        );
      }
      return createQaseReporter(config, qase);
    },
  };
}
