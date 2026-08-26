/**
 * Provider lookup. A `switch`, not a registry.
 *
 * A registry buys dynamic registration, which nobody can use: providers ship inside this package, so the
 * set is known at build time. A `switch` also fails at the right moment — an unknown `TMS_PROVIDER` is a
 * typo in a config file, and it should say so by name rather than resolve to `undefined` three calls
 * later.
 *
 * @example
 * const provider = resolveProvider(readConfig());
 */
import type { TmsConfig } from '../config.js';
import type { TmsProvider } from '../provider.js';
import { createQaseProvider } from './qase/index.js';

export const KNOWN_PROVIDERS = ['qase'] as const;

export function resolveProvider(config: TmsConfig): TmsProvider {
  switch (config.provider) {
    case 'qase':
      return createQaseProvider(config);
    default:
      throw new Error(
        `unknown TMS_PROVIDER "${config.provider}" — known providers: ${KNOWN_PROVIDERS.join(', ')}`,
      );
  }
}
